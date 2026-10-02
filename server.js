const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { execFile } = require("child_process");
const util = require("util");

const execFileAsync = util.promisify(execFile);

const app = express();
const PORT = process.env.PORT || 10000;

// --------------------------------------------------
// Middleware
// --------------------------------------------------

app.use(cors());

app.use(express.json({ limit: "1mb" }));

// General API rate limit
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "error",
    error: "Too many requests. Please try again later."
  }
});

app.use(limiter);

// --------------------------------------------------
// Configuration
// --------------------------------------------------

const SAVEAPI_URL = "https://api.saveapi.org/v1/download";

const YTDLP_TIMEOUT = 45 * 1000;

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}

function isTikTokUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    return (
      host === "tiktok.com" ||
      host.endsWith(".tiktok.com")
    );
  } catch {
    return false;
  }
}

function getResolution(format) {
  if (!format) {
    return "";
  }

  if (
    Number.isFinite(format.width) &&
    Number.isFinite(format.height) &&
    format.width > 0 &&
    format.height > 0
  ) {
    return `${format.width} x ${format.height}`;
  }

  if (
    Number.isFinite(format.height) &&
    format.height > 0
  ) {
    return `${format.height}p`;
  }

  if (format.quality) {
    return String(format.quality);
  }

  if (format.label) {
    return String(format.label);
  }

  return "";
}

function safeNumber(value) {
  return Number.isFinite(Number(value))
    ? Number(value)
    : null;
}

// --------------------------------------------------
// SaveAPI - TikTok
// --------------------------------------------------

async function resolveTikTokWithSaveAPI(tiktokUrl) {
  const apiKey = process.env.SAVEAPI_KEY;

  if (!apiKey) {
    throw new Error("SAVEAPI_KEY is not configured on the server.");
  }

  const endpoint =
    SAVEAPI_URL +
    "?url=" +
    encodeURIComponent(tiktokUrl);

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(30000)
  });

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `SaveAPI returned an invalid response (${response.status}).`
    );
  }

  if (!response.ok || data.success === false) {
    const errorCode =
      data &&
      data.error &&
      data.error.code
        ? data.error.code
        : `HTTP_${response.status}`;

    const errorMessage =
      data &&
      data.error &&
      data.error.message
        ? data.error.message
        : "SaveAPI could not resolve this TikTok URL.";

    const error = new Error(errorMessage);
    error.code = errorCode;
    error.httpStatus = response.status;

    throw error;
  }

  if (!data.success) {
    throw new Error("SaveAPI could not resolve this TikTok URL.");
  }

  // ------------------------------------------------
  // Prefer SaveAPI formats[] when available.
  // TikTok can provide several renditions there.
  // ------------------------------------------------

  let sourceFormats = [];

  if (Array.isArray(data.formats) && data.formats.length > 0) {
    sourceFormats = data.formats;
  } else if (
    Array.isArray(data.medias) &&
    data.medias.length > 0
  ) {
    sourceFormats = data.medias;
  }

  const formats = sourceFormats
    .filter(item => {
      return (
        item &&
        typeof item.url === "string" &&
        item.url.startsWith("http")
      );
    })
    .map((item, index) => {
      const isAudio =
        item.type === "audio" ||
        item.format === "mp3" ||
        item.ext === "mp3";

      const label =
        item.label ||
        item.quality ||
        item.format ||
        (isAudio ? "Audio" : `Video ${index + 1}`);

      return {
        url: item.url,
        format_id:
          item.format ||
          item.label ||
          `saveapi_${index + 1}`,
        ext: item.ext || (isAudio ? "mp3" : "mp4"),
        resolution: isAudio
          ? ""
          : getResolution(item),
        width: safeNumber(item.width),
        height: safeNumber(item.height),
        filesize:
          item.size_mb != null
            ? Math.round(Number(item.size_mb) * 1024 * 1024)
            : null,
        vcodec: isAudio ? "none" : "unknown",
        acodec: isAudio ? "mp3" : "unknown",
        type: item.type || (isAudio ? "audio" : "video"),
        label: String(label),
        watermark:
          typeof item.watermark === "boolean"
            ? item.watermark
            : null
      };
    });

  if (formats.length === 0) {
    throw new Error(
      "SaveAPI successfully resolved the TikTok URL but returned no downloadable media."
    );
  }

  const meta = data.meta || {};

  return {
    status: "success",

    title:
      meta.title ||
      meta.text ||
      "TikTok Video",

    uploader:
      meta.author ||
      "",

    thumbnail:
      meta.thumbnail ||
      "",

    duration:
      safeNumber(meta.duration) || 0,

    webpage_url:
      data.source_url ||
      tiktokUrl,

    platform: "TikTok",

    formats
  };
}

// --------------------------------------------------
// yt-dlp - Non-TikTok platforms
// --------------------------------------------------

async function resolveWithYtDlp(inputUrl) {
  const args = [
    "--dump-single-json",
    "--no-warnings",
    "--no-playlist",
    "--skip-download",
    "--ignore-config",
    inputUrl
  ];

  const { stdout } = await execFileAsync(
    "yt-dlp",
    args,
    {
      timeout: YTDLP_TIMEOUT,
      maxBuffer: 20 * 1024 * 1024
    }
  );

  if (!stdout || !stdout.trim()) {
    throw new Error("yt-dlp returned no information.");
  }

  let data;

  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error("yt-dlp returned invalid JSON.");
  }

  const formats = Array.isArray(data.formats)
    ? data.formats
    : [];

  const usableFormats = formats
    .filter(format => {
      return (
        format &&
        typeof format.url === "string" &&
        format.url.startsWith("http") &&
        (
          format.vcodec !== "none" ||
          format.acodec !== "none"
        )
      );
    })
    .map(format => {
      return {
        url: format.url,

        format_id:
          format.format_id != null
            ? String(format.format_id)
            : "",

        ext:
          format.ext || "mp4",

        resolution:
          getResolution(format),

        width:
          safeNumber(format.width),

        height:
          safeNumber(format.height),

        filesize:
          safeNumber(format.filesize) ||
          safeNumber(format.filesize_approx),

        vcodec:
          format.vcodec || "none",

        acodec:
          format.acodec || "none",

        fps:
          safeNumber(format.fps),

        format_note:
          format.format_note || "",

        tbr:
          safeNumber(format.tbr)
      };
    });

  // Some extractors provide a direct URL at the top level.
  if (
    usableFormats.length === 0 &&
    typeof data.url === "string" &&
    data.url.startsWith("http")
  ) {
    usableFormats.push({
      url: data.url,
      format_id: "default",
      ext: data.ext || "mp4",
      resolution: getResolution(data),
      width: safeNumber(data.width),
      height: safeNumber(data.height),
      filesize:
        safeNumber(data.filesize) ||
        safeNumber(data.filesize_approx),
      vcodec: data.vcodec || "unknown",
      acodec: data.acodec || "unknown"
    });
  }

  if (usableFormats.length === 0) {
    throw new Error(
      "No downloadable media formats were returned."
    );
  }

  return {
    status: "success",

    title:
      data.title ||
      "Video",

    uploader:
      data.uploader ||
      data.channel ||
      "",

    thumbnail:
      data.thumbnail ||
      "",

    duration:
      safeNumber(data.duration) || 0,

    webpage_url:
      data.webpage_url ||
      inputUrl,

    platform:
      data.extractor_key ||
      data.extractor ||
      "Unknown",

    formats: usableFormats
  };
}

// --------------------------------------------------
// Routes
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "success",
    service: "NetSaves API",
    message: "NetSaves downloader backend is online."
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "success"
  });
});

app.get("/version", async (req, res) => {
  try {
    const { stdout } = await execFileAsync(
      "yt-dlp",
      ["--version"],
      {
        timeout: 10000
      }
    );

    res.json({
      status: "success",
      "yt-dlp": stdout.trim()
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: "Unable to determine yt-dlp version."
    });
  }
});

// --------------------------------------------------
// Main downloader endpoint
// --------------------------------------------------

app.get("/video", async (req, res) => {
  const inputUrl =
    typeof req.query.url === "string"
      ? req.query.url.trim()
      : "";

  if (!inputUrl) {
    return res.status(400).json({
      status: "error",
      error: "Please provide a video URL."
    });
  }

  if (!isValidHttpUrl(inputUrl)) {
    return res.status(400).json({
      status: "error",
      error: "Please provide a valid HTTP or HTTPS URL."
    });
  }

  // ------------------------------------------------
  // TikTok -> SaveAPI
  // ------------------------------------------------

  if (isTikTokUrl(inputUrl)) {
    try {
      const result =
        await resolveTikTokWithSaveAPI(inputUrl);

      return res.json(result);

    } catch (error) {
      console.error(
        "SaveAPI TikTok error:",
        error.code || "",
        error.message
      );

      let statusCode = 502;

      if (
        error.code === "INVALID_URL" ||
        error.code === "UNSUPPORTED_PLATFORM"
      ) {
        statusCode = 400;
      } else if (
        error.code === "MISSING_API_KEY" ||
        error.code === "INVALID_API_KEY" ||
        error.code === "KEY_REVOKED" ||
        error.code === "KEY_EXPIRED"
      ) {
        statusCode = 500;
      } else if (
        error.code === "RATE_LIMITED" ||
        error.code === "QUOTA_EXCEEDED"
      ) {
        statusCode = 429;
      } else if (
        error.code === "PRIVATE_CONTENT" ||
        error.code === "MEDIA_NOT_FOUND"
      ) {
        statusCode = 404;
      }

      return res.status(statusCode).json({
        status: "error",
        error:
          error.message ||
          "SaveAPI could not process this TikTok URL.",
        code:
          error.code ||
          "SAVEAPI_ERROR"
      });
    }
  }

  // ------------------------------------------------
  // Everything else -> yt-dlp
  // This preserves Twitch and other existing
  // downloader functionality.
  // ------------------------------------------------

  try {
    const result =
      await resolveWithYtDlp(inputUrl);

    return res.json(result);

  } catch (error) {
    console.error(
      "yt-dlp error:",
      error.message
    );

    return res.status(502).json({
      status: "error",
      error:
        error.message ||
        "Unable to extract this video."
    });
  }
});

// --------------------------------------------------
// 404
// --------------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    status: "error",
    error: "Endpoint not found."
  });
});

// --------------------------------------------------
// Error handler
// --------------------------------------------------

app.use((err, req, res, next) => {
  console.error("Server error:", err);

  res.status(500).json({
    status: "error",
    error: "Internal server error."
  });
});

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `NetSaves API running on port ${PORT}`
  );
});
