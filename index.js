const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" }));

const PORT = Number(process.env.PORT || 8899);

const NANOBANANA_ENDPOINT = process.env.NANOBANANA_ENDPOINT || "";
const NANOBANANA_API_KEY = process.env.NANOBANANA_API_KEY || "";
const NANOBANANA_MODEL = process.env.NANOBANANA_MODEL || "nanobananapro";
const NANOBANANA_AUTH_HEADER = process.env.NANOBANANA_AUTH_HEADER || "Authorization";
const NANOBANANA_AUTH_SCHEME = process.env.NANOBANANA_AUTH_SCHEME || "Bearer";
const NANOBANANA_EXTRA_HEADERS_JSON = process.env.NANOBANANA_EXTRA_HEADERS_JSON || "";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash";
const GEMINI_ENDPOINT =
  process.env.GEMINI_ENDPOINT ||
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

async function parseResponseDetail(response) {
  let text = "";
  try {
    text = await response.text();
  } catch (_error) {
    return { status: response.status, detail: "" };
  }
  return {
    status: response.status,
    detail: text.slice(0, 700)
  };
}

function buildNanobananaHeaders() {
  const headers = {
    "Content-Type": "application/json"
  };

  if (NANOBANANA_API_KEY) {
    headers[NANOBANANA_AUTH_HEADER] = NANOBANANA_AUTH_SCHEME
      ? `${NANOBANANA_AUTH_SCHEME} ${NANOBANANA_API_KEY}`.trim()
      : NANOBANANA_API_KEY;
  }

  if (NANOBANANA_EXTRA_HEADERS_JSON) {
    const extra = parseJsonSafe(NANOBANANA_EXTRA_HEADERS_JSON);
    if (extra && typeof extra === "object") {
      Object.assign(headers, extra);
    }
  }

  return headers;
}

function withApiKeyQueryIfGoogle(url, apiKey) {
  const raw = String(url || "");
  if (!raw.includes("generativelanguage.googleapis.com")) return raw;
  if (!apiKey) return raw;
  if (raw.includes("key=")) return raw;
  const sep = raw.includes("?") ? "&" : "?";
  return `${raw}${sep}key=${encodeURIComponent(apiKey)}`;
}

function toInlineDataFromDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(.+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2]
  };
}

function normalizeImageResponse(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.imageDataUrl === "string" && data.imageDataUrl) return data.imageDataUrl;
  if (typeof data.image_data_url === "string" && data.image_data_url) return data.image_data_url;
  if (typeof data.url === "string" && data.url) return data.url;
  if (data.result && typeof data.result.imageDataUrl === "string") return data.result.imageDataUrl;
  if (data.result && typeof data.result.url === "string") return data.result.url;

  const firstFromData = Array.isArray(data.data) ? data.data[0] : null;
  if (firstFromData && typeof firstFromData.url === "string") return firstFromData.url;
  if (firstFromData && typeof firstFromData.b64_json === "string") {
    return `data:image/png;base64,${firstFromData.b64_json}`;
  }

  const firstFromOutput = Array.isArray(data.output) ? data.output[0] : null;
  if (firstFromOutput && typeof firstFromOutput.url === "string") return firstFromOutput.url;
  if (firstFromOutput && typeof firstFromOutput.b64_json === "string") {
    return `data:image/png;base64,${firstFromOutput.b64_json}`;
  }
  if (firstFromOutput && typeof firstFromOutput.base64 === "string") {
    const mime = firstFromOutput.mime_type || "image/png";
    return `data:${mime};base64,${firstFromOutput.base64}`;
  }

  if (typeof data.base64 === "string" && data.base64) {
    const mime = data.mime_type || "image/png";
    return `data:${mime};base64,${data.base64}`;
  }

  const candidate = data.candidates && data.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  if (Array.isArray(parts)) {
    const imagePart = parts.find((p) => p && p.inlineData && p.inlineData.data);
    if (imagePart) {
      const mime = imagePart.inlineData.mimeType || "image/png";
      return `data:${mime};base64,${imagePart.inlineData.data}`;
    }
    const imagePartSnake = parts.find((p) => p && p.inline_data && p.inline_data.data);
    if (imagePartSnake) {
      const mime = imagePartSnake.inline_data.mime_type || "image/png";
      return `data:${mime};base64,${imagePartSnake.inline_data.data}`;
    }
  }

  return "";
}

function extractGeminiText(responseJson) {
  const candidate = responseJson && responseJson.candidates && responseJson.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  if (!Array.isArray(parts)) return "";
  const textPart = parts.find((p) => typeof p.text === "string");
  return textPart ? textPart.text : "";
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "mirai-news-api",
    providers: {
      nanobananaproConfigured: Boolean(NANOBANANA_ENDPOINT),
      geminiConfigured: Boolean(GEMINI_API_KEY)
    }
  });
});

app.post("/api/image/generate", async (req, res) => {
  try {
    if (!NANOBANANA_ENDPOINT) {
      res.status(500).json({
        ok: false,
        error: "NANOBANANA_ENDPOINT is not configured in .env"
      });
      return;
    }

    const payload = req.body || {};
    // 画像生成APIに必ず年齢指示を通す（子どもっぽい出力を防ぐ）
    const adultReinforcement =
      "CRITICAL: The person in the image MUST be shown as an ADULT, 25-35 years old, mature face and body. NOT a child. Same identity as the input photo but clearly aged up to adulthood. ";
    const promptText =
      adultReinforcement +
      [payload.prompts?.system || "", payload.prompts?.user || ""]
        .join("\n\n")
        .trim();
    const clientNegative = payload.prompts?.negative || "";
    const serverNegative = "child, childlike, baby face, kid, toddler, infant look, youthful child face";
    const negativeText = `\n\nNegative: ${[serverNegative, clientNegative].filter(Boolean).join(". ")}`;
    const inlineData = toInlineDataFromDataUrl(payload.input_image_data_url);
    const promptPart = { text: `${promptText}${negativeText}`.trim() };
    // 参照画像を先に送る（多くの画像編集APIは「画像→指示」の順を期待）
    const parts = inlineData ? [{ inlineData }, promptPart] : [promptPart];

    // NANOBANANA/Gemini の REST API は imageGenerationConfig を認識しないため省略（デフォルトで画像生成）
    const body = {
      contents: [
        {
          role: "user",
          parts
        }
      ],
      generationConfig: {
        responseModalities: ["IMAGE", "TEXT"]
      }
    };

    const targetUrl = withApiKeyQueryIfGoogle(
      NANOBANANA_ENDPOINT,
      NANOBANANA_API_KEY || GEMINI_API_KEY
    );
    const headers = buildNanobananaHeaders();
    if (targetUrl.includes("generativelanguage.googleapis.com")) {
      delete headers[NANOBANANA_AUTH_HEADER];
    }

    const sendRequest = async (requestBody) =>
      fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody)
      });

    let response = await sendRequest(body);
    let data = null;
    if (!response.ok) {
      const detail = await parseResponseDetail(response);
      const canRetryWithoutImage =
        inlineData &&
        detail.status === 400 &&
        /Unable to process input image/i.test(detail.detail || "");
      if (canRetryWithoutImage) {
        console.warn("[image/generate] retrying without input image (provider rejected image)");
        const promptOnlyBody = {
          ...body,
          contents: [
            {
              role: "user",
              parts: [promptPart]
            }
          ]
        };
        response = await sendRequest(promptOnlyBody);
      } else {
        console.error("[image/generate] provider error", detail.status, detail.detail);
        res.status(502).json({
          ok: false,
          error: "nanobananapro request failed",
          provider_status: detail.status,
          provider_detail: detail.detail
        });
        return;
      }
    }

    if (!response.ok) {
      const detail = await parseResponseDetail(response);
      console.error("[image/generate] provider error (after retry)", detail.status, detail.detail);
      res.status(502).json({
        ok: false,
        error: "nanobananapro request failed",
        provider_status: detail.status,
        provider_detail: detail.detail
      });
      return;
    }

    data = await response.json();
    const imageDataUrl = normalizeImageResponse(data);
    if (!imageDataUrl) {
      const sample = JSON.stringify(data).slice(0, 500);
      console.error("[image/generate] no image in response, sample:", sample);
      res.status(502).json({
        ok: false,
        error: "nanobananapro response did not include a usable image",
        provider_payload_sample: sample
      });
      return;
    }

    res.json({
      ok: true,
      imageDataUrl
    });
  } catch (error) {
    console.error("[image/generate] failed", error);
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.post("/api/text/generate", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      res.status(500).json({
        ok: false,
        error: "GEMINI_API_KEY is not configured in .env"
      });
      return;
    }

    const payload = req.body || {};
    const prompts = payload.prompts || {};
    const targetEndpoint = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const temperature = Number.isFinite(payload.temperature) ? payload.temperature : 0.7;

    const geminiBody = {
      systemInstruction: {
        parts: [{ text: String(prompts.system || "") }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: String(prompts.user || "") }]
        }
      ],
      generationConfig: {
        temperature,
        responseMimeType: "application/json"
      }
    };

    const response = await fetch(targetEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(geminiBody)
    });

    if (!response.ok) {
      const detail = await parseResponseDetail(response);
      res.status(502).json({
        ok: false,
        error: "Gemini request failed",
        provider_status: detail.status,
        provider_detail: detail.detail
      });
      return;
    }

    const data = await response.json();
    const rawText = extractGeminiText(data);
    const parsed = parseJsonSafe(rawText);
    if (!parsed) {
      res.status(502).json({
        ok: false,
        error: "Gemini response was not valid JSON",
        raw: String(rawText || "").slice(0, 700)
      });
      return;
    }

    res.json(parsed);
  } catch (error) {
    console.error("[text/generate] failed", error);
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

function buildArticlePrompt(input) {
  const system = [
    "あなたは子ども向けワークショップの新聞記事ライターです。",
    "目的は、参加者の自己肯定感を高める前向きな未来像を短く魅力的に伝えることです。",
    "必須ルール:",
    "- やさしい日本語。年齢に応じた語彙を使う。",
    "- 職業の優劣を示さない。断定的な成功保証をしない。",
    "- 暴力・性的・差別・恐怖・誹謗中傷を含めない。",
    "- 医療/法律/投資などの助言をしない。",
    "- 出力は必ずJSONのみ。"
  ].join("\n");

  const user = [
    "以下の入力から「未来新聞」記事を作ってください。",
    "入力:",
    "- なりたい職業: " + (input.future_job || ""),
    "- 好きなこと: " + (input.likes || ""),
    "- やってみたいこと: " + (input.solve_issue || ""),
    "- 紙面テンプレート: " + (input.template_type || "nikkei"),
    "- 性別: " + (input.gender === "female" ? "女の子" : "男の子"),
    "",
    "出力要件:",
    "1) 記事タイトル (article_title): 8〜18文字",
    "2) 大見出し (h1_title): 18〜32文字",
    "3) リード文 (lead): 1〜2文、合計60〜110文字",
    "4) 中見出しを2つ (h2_titles): 文字列の配列、各8〜18文字",
    "5) 本文セクション (sections): 2件のオブジェクト配列。各要素は { \"heading\": \"中見出しと同じ\", \"body\": \"50〜120文字\" }",
    "6) 未来小ネタ (side_notes): 1〜3件。各ノートは \"title\"(8〜18文字), \"body\"(20〜50文字), \"category\" を含む。category は \"future_stock\" | \"future_weather\" | \"future_ad\" のいずれか",
    "",
    "JSONスキーマ厳守で返してください:",
    "{",
    "  \"article_title\": \"...\",",
    "  \"h1_title\": \"...\",",
    "  \"lead\": \"...\",",
    "  \"h2_titles\": [\"...\", \"...\"],",
    "  \"sections\": [",
    "    { \"heading\": \"...\", \"body\": \"...\" },",
    "    { \"heading\": \"...\", \"body\": \"...\" }",
    "  ],",
    "  \"side_notes\": [",
    "    { \"category\": \"future_stock\", \"title\": \"...\", \"body\": \"...\" }",
    "  ]",
    "}"
  ].join("\n");

  return { system, user };
}

function validateArticleResponse(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (typeof obj.article_title !== "string") return false;
  if (typeof obj.h1_title !== "string") return false;
  if (typeof obj.lead !== "string") return false;
  if (!Array.isArray(obj.h2_titles) || obj.h2_titles.length < 2) return false;
  if (!Array.isArray(obj.sections) || obj.sections.length < 2) return false;
  if (typeof obj.sections[0].heading !== "string" || typeof obj.sections[0].body !== "string") return false;
  if (typeof obj.sections[1].heading !== "string" || typeof obj.sections[1].body !== "string") return false;
  if (!Array.isArray(obj.side_notes)) return false;
  return true;
}

function sanitizeArticleResponse(obj) {
  const fallback = {
    article_title: "20年後のわたし",
    h1_title: "未来でかがやく、わたしのチャレンジ",
    lead: "好きなことを大切にしながら、みんなの役に立つくふうを続けています。",
    h2_titles: ["夢をかなえた日", "これからの挑戦"],
    sections: [
      { heading: "夢をかなえた日", body: "20年後のわたしは、得意なことを生かして社会の課題に取り組んでいます。" },
      { heading: "これからの挑戦", body: "これからも周りと協力しながら、新しい価値を生み出していきます。" }
    ],
    side_notes: [
      { category: "future_weather", title: "火星てんき速報", body: "火星コロニーは今日も快晴です。" }
    ]
  };
  if (!validateArticleResponse(obj)) return fallback;
  return {
    article_title: String(obj.article_title).slice(0, 24) || fallback.article_title,
    h1_title: String(obj.h1_title).slice(0, 40) || fallback.h1_title,
    lead: String(obj.lead).slice(0, 140) || fallback.lead,
    h2_titles: [
      String(obj.h2_titles[0] || "").slice(0, 24) || fallback.h2_titles[0],
      String(obj.h2_titles[1] || "").slice(0, 24) || fallback.h2_titles[1]
    ],
    sections: [
      { heading: String(obj.sections[0].heading || "").slice(0, 24) || fallback.sections[0].heading, body: String(obj.sections[0].body || "").slice(0, 140) || fallback.sections[0].body },
      { heading: String(obj.sections[1].heading || "").slice(0, 24) || fallback.sections[1].heading, body: String(obj.sections[1].body || "").slice(0, 140) || fallback.sections[1].body }
    ],
    side_notes: Array.isArray(obj.side_notes) ? obj.side_notes.slice(0, 3).map((n) => ({
      category: n && (n.category === "future_stock" || n.category === "future_weather" || n.category === "future_ad") ? n.category : "future_ad",
      title: String(n && n.title ? n.title : "").slice(0, 24),
      body: String(n && n.body ? n.body : "").slice(0, 60)
    })).filter((n) => n.title || n.body) : fallback.side_notes
  };
}

app.post("/api/article/generate", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      res.status(500).json({
        ok: false,
        error: "GEMINI_API_KEY is not configured in .env"
      });
      return;
    }

    const input = req.body || {};
    const { system, user } = buildArticlePrompt(input);
    const targetEndpoint = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    const geminiBody = {
      systemInstruction: {
        parts: [{ text: system }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: user }]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        responseMimeType: "application/json"
      }
    };

    const response = await fetch(targetEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody)
    });

    if (!response.ok) {
      const detail = await parseResponseDetail(response);
      res.status(502).json({
        ok: false,
        error: "Gemini request failed",
        provider_status: detail.status,
        provider_detail: detail.detail
      });
      return;
    }

    const data = await response.json();
    const rawText = extractGeminiText(data);
    const parsed = parseJsonSafe(rawText);
    if (!parsed) {
      res.status(502).json({
        ok: false,
        error: "Gemini response was not valid JSON",
        raw: String(rawText || "").slice(0, 700)
      });
      return;
    }

    const article = sanitizeArticleResponse(parsed);
    res.json(article);
  } catch (error) {
    console.error("[article/generate] failed", error);
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.listen(PORT, () => {
  console.log(`[mirai-news-api] listening on http://localhost:${PORT}`);
  console.log(
    "[mirai-news-api] env: image=" +
      (NANOBANANA_ENDPOINT ? "OK" : "MISSING(NANOBANANA_ENDPOINT)") +
      ", text=" +
      (GEMINI_API_KEY ? "OK" : "MISSING(GEMINI_API_KEY)")
  );
});
