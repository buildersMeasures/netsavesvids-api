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

const SAVEAPI_DOWNLOAD_URL =
  "https://api.saveapi.org/v1/download";

const SAVEAPI_YOUTUBE_INFO_URL =
  "https://api.saveapi.org/v1/youtube/info";

const SAVEAPI_YOUTUBE_CREATE_URL =
  "https://api.saveapi.org/v1/youtube/create";

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

// --------------------------------------------------
// YouTube URL detection
// --------------------------------------------------

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    return (
      host === "youtube.com" ||
      host === "www.youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com" ||
      host === "youtu.be" ||
      host === "www.youtu.be"
    );
  } catch {
    return false;
  }
}

// --------------------------------------------------
// YouTube URL validation
// --------------------------------------------------

function isSupportedYouTubeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    if (
      host === "youtu.be" ||
      host === "www.youtu.be"
    ) {
      return url.pathname.length > 1;
    }

    if (
      host === "youtube.com" ||
      host === "www.youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com"
    ) {
      if (url.pathname === "/watch") {
        return Boolean(url.searchParams.get("v"));
      }

      if (url.pathname.startsWith("/shorts/")) {
        return url.pathname.split("/")[2].length > 0;
      }

      if (url.pathname.startsWith("/embed/")) {
        return url.pathname.split("/")[2].length > 0;
      }

      return false;
    }

    return false;
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

function getSaveApiError(data, fallbackMessage) {
  if (
    data &&
    data.error &&
    typeof data.error.message === "string"
  ) {
    return data.error.message;
  }

  return fallbackMessage;
}

// --------------------------------------------------
// SaveAPI error status mapping
// --------------------------------------------------

function getSaveApiStatusCode(code) {
  switch (code) {
    case "INVALID_URL":
    case "UNSUPPORTED_PLATFORM":
    case "INVALID_FORMAT":
      return 400;

    case "MISSING_API_KEY":
    case "INVALID_API_KEY":
      return 500;

    case "KEY_REVOKED":
    case "KEY_EXPIRED":
    case "ACCOUNT_SUSPENDED":
    case "IP_NOT_ALLOWED":
    case "PLATFORM_NOT_ALLOWED":
      return 500;

    case "PRIVATE_CONTENT":
    case "MEDIA_NOT_FOUND":
      return 404;

    case "RATE_LIMITED":
    case "QUOTA_EXCEEDED":
      return 429;

    case "LINK_EXPIRED":
      return 410;

    case "UPSTREAM_TIMEOUT":
      return 504;

    case "UPSTREAM_ERROR":
      return 502;

    default:
      return 502;
  }
}

// --------------------------------------------------
// SaveAPI - TikTok
// --------------------------------------------------

async function resolveTikTokWithSaveAPI(tiktokUrl) {
  const apiKey = process.env.SAVEAPI_KEY;

  if (!apiKey) {
    throw new Error(
      "SAVEAPI_KEY is not configured on the server."
    );
  }

  const endpoint =
    SAVEAPI_DOWNLOAD_URL +
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
    throw new Error(
      "SaveAPI could not resolve this TikTok URL."
    );
  }

  let sourceFormats = [];

  if (
    Array.isArray(data.formats) &&
    data.formats.length > 0
  ) {
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
        (isAudio
          ? "Audio"
          : `Video ${index + 1}`);

      return {
        url: item.url,

        format_id:
          item.format ||
          item.label ||
          `saveapi_${index + 1}`,

        ext:
          item.ext ||
          (isAudio ? "mp3" : "mp4"),

        resolution:
          isAudio
            ? ""
            : getResolution(item),

        width:
          safeNumber(item.width),

        height:
          safeNumber(item.height),

        filesize:
          item.size_mb != null
            ? Math.round(
                Number(item.size_mb) *
                1024 *
                1024
              )
            : null,

        vcodec:
          isAudio
            ? "none"
            : "unknown",

        acodec:
          isAudio
            ? "mp3"
            : "unknown",

        type:
          item.type ||
          (isAudio ? "audio" : "video"),

        label:
          String(label),

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

    platform:
      "TikTok",

    formats
  };
}

// --------------------------------------------------
// SaveAPI - YouTube Info
// --------------------------------------------------

async function resolveYouTubeInfoWithSaveAPI(youtubeUrl) {
  const apiKey = process.env.SAVEAPI_KEY;

  if (!apiKey) {
    const error = new Error(
      "SAVEAPI_KEY is not configured on the server."
    );

    error.code = "MISSING_API_KEY";

    throw error;
  }

  const endpoint =
    SAVEAPI_YOUTUBE_INFO_URL +
    "?url=" +
    encodeURIComponent(youtubeUrl);

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
    const error = new Error(
      `SaveAPI returned an invalid YouTube response (${response.status}).`
    );

    error.code =
      `HTTP_${response.status}`;

    throw error;
  }

  if (!response.ok || data.success === false) {
    const errorCode =
      data &&
      data.error &&
      data.error.code
        ? data.error.code
        : `HTTP_${response.status}`;

    const errorMessage =
      getSaveApiError(
        data,
        "SaveAPI could not resolve this YouTube URL."
      );

    const error = new Error(
      errorMessage
    );

    error.code = errorCode;
    error.httpStatus = response.status;

    throw error;
  }

  if (!data.success) {
    const error = new Error(
      "SaveAPI could not resolve this YouTube URL."
    );

    error.code = "SAVEAPI_ERROR";

    throw error;
  }

  // ------------------------------------------------
  // Convert YouTube video formats
  // ------------------------------------------------

  const videoFormats =
    Array.isArray(data.formats)
      ? data.formats
      : [];

  const audioFormats =
    Array.isArray(data.audio_formats)
      ? data.audio_formats
      : [];

  const formats = [];

  videoFormats.forEach((item, index) => {
    if (
      !item ||
      typeof item.quality !== "string"
    ) {
      return;
    }

    formats.push({
      type: "video",

      quality:
        item.quality,

      format_id:
        `youtube_${item.quality}`,

      ext:
        "mp4",

      resolution:
        item.quality,

      filesize:
        safeNumber(item.file_size),

      filesize_str:
        item.file_size_str || "",

      exact:
        item.exact !== false,

      index
    });
  });

  audioFormats.forEach((item, index) => {
    if (
      !item ||
      typeof item.quality !== "string"
    ) {
      return;
    }

    formats.push({
      type: "audio",

      quality:
        item.quality,

      format_id:
        `youtube_audio_${item.quality}`,

      ext:
        item.quality.toLowerCase(),

      resolution:
        "",

      filesize:
        safeNumber(item.file_size),

      filesize_str:
        item.file_size_str || "",

      exact:
        item.exact !== false,

      index
    });
  });

  if (formats.length === 0) {
    const error = new Error(
      "SaveAPI returned YouTube information but no downloadable formats were found."
    );

    error.code = "MEDIA_NOT_FOUND";

    throw error;
  }

  return {
    status: "success",

    title:
      data.title ||
      "YouTube Video",

    uploader:
      data.author ||
      "",

    thumbnail:
      data.thumbnail ||
      "",

    duration:
      safeNumber(data.duration_seconds) || 0,

    duration_str:
      data.duration_str ||
      "",

    webpage_url:
      data.source_url ||
      youtubeUrl,

    video_id:
      data.video_id ||
      "",

    is_short:
      data.is_short === true,

    platform:
      "YouTube",

    formats,

    // Keep these separately available to the
    // frontend if it wants to group them.
    video_formats:
      videoFormats.map(item => ({
        quality:
          item.quality,

        file_size:
          safeNumber(item.file_size),

        file_size_str:
          item.file_size_str || "",

        exact:
          item.exact !== false
      })),

    audio_formats:
      audioFormats.map(item => ({
        quality:
          item.quality,

        file_size:
          safeNumber(item.file_size),

        file_size_str:
          item.file_size_str || "",

        exact:
          item.exact !== false
      }))
  };
}

// --------------------------------------------------
// SaveAPI - YouTube Create
// --------------------------------------------------

async function createYouTubeDownload(
  youtubeUrl,
  quality
) {
  const apiKey = process.env.SAVEAPI_KEY;

  if (!apiKey) {
    const error = new Error(
      "SAVEAPI_KEY is not configured on the server."
    );

    error.code = "MISSING_API_KEY";

    throw error;
  }

  const cleanQuality =
    typeof quality === "string"
      ? quality.trim().toLowerCase()
      : "";

  if (!cleanQuality) {
    const error = new Error(
      "Please specify a YouTube quality."
    );

    error.code = "INVALID_FORMAT";

    throw error;
  }

  const allowedAudio =
    cleanQuality === "mp3" ||
    cleanQuality === "m4a";

  const allowedVideo =
    /^\d+p$/i.test(cleanQuality);

  if (!allowedAudio && !allowedVideo) {
    const error = new Error(
      "Invalid YouTube quality."
    );

    error.code = "INVALID_FORMAT";

    throw error;
  }

  const endpoint =
    SAVEAPI_YOUTUBE_CREATE_URL +
    "?url=" +
    encodeURIComponent(youtubeUrl) +
    "&quality=" +
    encodeURIComponent(cleanQuality);

  const response = await fetch(endpoint, {
    method: "GET",

    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json"
    },

    signal: AbortSignal.timeout(60000)
  });

  let data;

  try {
    data = await response.json();
  } catch {
    const error = new Error(
      `SaveAPI returned an invalid YouTube download response (${response.status}).`
    );

    error.code =
      `HTTP_${response.status}`;

    throw error;
  }

  if (!response.ok || data.success === false) {
    const errorCode =
      data &&
      data.error &&
      data.error.code
        ? data.error.code
        : `HTTP_${response.status}`;

    const errorMessage =
      getSaveApiError(
        data,
        "SaveAPI could not create the selected YouTube download."
      );

    const error = new Error(
      errorMessage
    );

    error.code = errorCode;
    error.httpStatus = response.status;

    throw error;
  }

  if (
    !data.success ||
    typeof data.url !== "string" ||
    !data.url.startsWith("http")
  ) {
    const error = new Error(
      "SaveAPI did not return a valid YouTube download URL."
    );

    error.code = "NO_DOWNLOAD_URL";

    throw error;
  }

  return {
    status: "success",

    url:
      data.url,

    filename:
      data.filename ||
      "",

    file_size:
      safeNumber(data.file_size),

    file_size_str:
      data.file_size_str ||
      "",

    expires:
      data.expires ||
      null,

    quality:
      cleanQuality,

    mode:
      data.mode ||
      (allowedAudio
        ? "audio"
        : "video"),

    platform:
      "YouTube"
  };
}

// --------------------------------------------------
// yt-dlp - Non-TikTok / Non-YouTube platforms
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

  const { stdout } =
    await execFileAsync(
      "yt-dlp",
      args,
      {
        timeout:
          YTDLP_TIMEOUT,

        maxBuffer:
          20 * 1024 * 1024
      }
    );

  if (
    !stdout ||
    !stdout.trim()
  ) {
    throw new Error(
      "yt-dlp returned no information."
    );
  }

  let data;

  try {
    data =
      JSON.parse(stdout);
  } catch {
    throw new Error(
      "yt-dlp returned invalid JSON."
    );
  }

  const formats =
    Array.isArray(data.formats)
      ? data.formats
      : [];

  const usableFormats =
    formats
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
          url:
            format.url,

          format_id:
            format.format_id != null
              ? String(format.format_id)
              : "",

          ext:
            format.ext ||
            "mp4",

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
            format.vcodec ||
            "none",

          acodec:
            format.acodec ||
            "none",

          fps:
            safeNumber(format.fps),

          format_note:
            format.format_note ||
            "",

          tbr:
            safeNumber(format.tbr)
        };
      });

  if (
    usableFormats.length === 0 &&
    typeof data.url === "string" &&
    data.url.startsWith("http")
  ) {
    usableFormats.push({
      url:
        data.url,

      format_id:
        "default",

      ext:
        data.ext ||
        "mp4",

      resolution:
        getResolution(data),

      width:
        safeNumber(data.width),

      height:
        safeNumber(data.height),

      filesize:
        safeNumber(data.filesize) ||
        safeNumber(data.filesize_approx),

      vcodec:
        data.vcodec ||
        "unknown",

      acodec:
        data.acodec ||
        "unknown"
    });
  }

  if (
    usableFormats.length === 0
  ) {
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
      safeNumber(data.duration) ||
      0,

    webpage_url:
      data.webpage_url ||
      inputUrl,

    platform:
      data.extractor_key ||
      data.extractor ||
      "Unknown",

    formats:
      usableFormats
  };
}

// --------------------------------------------------
// Routes
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "success",

    service:
      "NetSaves API",

    message:
      "NetSaves downloader backend is online."
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "success"
  });
});

app.get("/version", async (req, res) => {
  try {
    const { stdout } =
      await execFileAsync(
        "yt-dlp",
        ["--version"],
        {
          timeout: 10000
        }
      );

    res.json({
      status: "success",

      "yt-dlp":
        stdout.trim()
    });

  } catch (error) {
    res.status(500).json({
      status: "error",

      error:
        "Unable to determine yt-dlp version."
    });
  }
});

// --------------------------------------------------
// YouTube download creation endpoint
//
// Example:
// /youtube/create?url=https%3A%2F%2Fyoutu.be%2FVIDEO&quality=720p
// --------------------------------------------------

app.get("/youtube/create", async (req, res) => {
  const inputUrl =
    typeof req.query.url === "string"
      ? req.query.url.trim()
      : "";

  const quality =
    typeof req.query.quality === "string"
      ? req.query.quality.trim()
      : "";

  if (!inputUrl) {
    return res.status(400).json({
      status: "error",
      error:
        "Please provide a YouTube URL."
    });
  }

  if (!isValidHttpUrl(inputUrl)) {
    return res.status(400).json({
      status: "error",
      error:
        "Please provide a valid HTTP or HTTPS URL."
    });
  }

  if (!isYouTubeUrl(inputUrl)) {
    return res.status(400).json({
      status: "error",
      error:
        "Please provide a YouTube URL."
    });
  }

  if (!isSupportedYouTubeUrl(inputUrl)) {
    return res.status(400).json({
      status: "error",
      error:
        "This YouTube URL format is not supported."
    });
  }

  if (!quality) {
    return res.status(400).json({
      status: "error",
      error:
        "Please specify a quality such as 360p, 720p, 1080p, mp3 or m4a."
    });
  }

  try {
    const result =
      await createYouTubeDownload(
        inputUrl,
        quality
      );

    return res.json(result);

  } catch (error) {
    console.error(
      "SaveAPI YouTube create error:",
      error.code || "",
      error.message
    );

    const statusCode =
      getSaveApiStatusCode(
        error.code
      );

    return res.status(statusCode).json({
      status: "error",

      error:
        error.message ||
        "Unable to create the YouTube download.",

      code:
        error.code ||
        "SAVEAPI_ERROR"
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
      error:
        "Please provide a video URL."
    });
  }

  if (!isValidHttpUrl(inputUrl)) {
    return res.status(400).json({
      status: "error",
      error:
        "Please provide a valid HTTP or HTTPS URL."
    });
  }

  // ------------------------------------------------
  // YouTube -> SaveAPI
  // ------------------------------------------------

  if (isYouTubeUrl(inputUrl)) {
    if (!isSupportedYouTubeUrl(inputUrl)) {
      return res.status(400).json({
        status: "error",
        error:
          "This YouTube URL format is not supported."
      });
    }

    try {
      const result =
        await resolveYouTubeInfoWithSaveAPI(
          inputUrl
        );

      return res.json(result);

    } catch (error) {
      console.error(
        "SaveAPI YouTube info error:",
        error.code || "",
        error.message
      );

      const statusCode =
        getSaveApiStatusCode(
          error.code
        );

      return res.status(statusCode).json({
        status: "error",

        error:
          error.message ||
          "SaveAPI could not process this YouTube URL.",

        code:
          error.code ||
          "SAVEAPI_ERROR"
      });
    }
  }

  // ------------------------------------------------
  // TikTok -> SaveAPI
  // ------------------------------------------------

  if (isTikTokUrl(inputUrl)) {
    try {
      const result =
        await resolveTikTokWithSaveAPI(
          inputUrl
        );

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
  //
  // This preserves Twitch and other existing
  // downloader functionality.
  // ------------------------------------------------

  try {
    const result =
      await resolveWithYtDlp(
        inputUrl
      );

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
    error:
      "Endpoint not found."
  });
});

// --------------------------------------------------
// Error handler
// --------------------------------------------------

app.use((err, req, res, next) => {
  console.error(
    "Server error:",
    err
  );

  res.status(500).json({
    status: "error",

    error:
      "Internal server error."
  });
});

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `NetSaves API running on port ${PORT}`
    );
  }
);
