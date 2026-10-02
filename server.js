const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;

// CORS
app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: {
    status: "error",
    error: "Too many requests. Please try again later."
  }
});

app.use("/video", limiter);

// Home
app.get("/", (req, res) => {
  res.json({
    status: "success",
    service: "NetSaves API",
    message: "NetSaves downloader backend is online."
  });
});

// Health
app.get("/health", (req, res) => {
  res.json({
    status: "success"
  });
});
// yt-dlp version
app.get("/version", (req, res) => {
  const process = spawn("yt-dlp", ["--version"]);

  let output = "";

  process.stdout.on("data", (data) => {
    output += data.toString();
  });

  process.on("close", (code) => {
    if (code !== 0) {
      return res.status(500).json({
        status: "error",
        error: "Could not determine yt-dlp version."
      });
    }

    res.json({
      status: "success",
      "yt-dlp": output.trim()
    });
  });
});

// Video
app.get("/video", (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({
      status: "error",
      error: "Missing video URL."
    });
  }

  try {
    const parsedUrl = new URL(url);

    if (
      parsedUrl.protocol !== "http:" &&
      parsedUrl.protocol !== "https:"
    ) {
      return res.status(400).json({
        status: "error",
        error: "Only HTTP and HTTPS URLs are supported."
      });
    }
  } catch {
    return res.status(400).json({
      status: "error",
      error: "Invalid video URL."
    });
  }

  const args = [
    "--dump-single-json",
    "--no-warnings",
    "--no-playlist",
    "--skip-download",
    "--js-runtimes",
    "deno",
    url
  ];

  const process = spawn("yt-dlp", args);

  let stdout = "";
  let stderr = "";

  process.stdout.on("data", (data) => {
    stdout += data.toString();
  });

  process.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  process.on("error", (error) => {
    return res.status(500).json({
      status: "error",
      error: error.message
    });
  });

  process.on("close", (code) => {
    if (code !== 0) {
      return res.status(500).json({
        status: "error",
        error: stderr.trim() || "yt-dlp failed.",
        exit_code: code
      });
    }

    try {
      const data = JSON.parse(stdout);

      return res.json({
        status: "success",
        title: data.title || "",
        uploader: data.uploader || data.channel || "",
        thumbnail: data.thumbnail || "",
        duration: data.duration || 0,
        webpage_url: data.webpage_url || url,
        platform: data.extractor_key || data.extractor || "",
        formats: Array.isArray(data.formats)
          ? data.formats
              .filter((format) => format.url)
              .map((format) => ({
                url: format.url,
                format_id: format.format_id || "",
                ext: format.ext || "",
                resolution: format.resolution || "",
                width: format.width || null,
                height: format.height || null,
                filesize:
                  format.filesize ||
                  format.filesize_approx ||
                  null,
                vcodec: format.vcodec || "",
                acodec: format.acodec || ""
              }))
          : []
      });
    } catch (error) {
      return res.status(500).json({
        status: "error",
        error: "yt-dlp returned an invalid response.",
        details: error.message
      });
    }
  });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`NetSaves API running on port ${PORT}`);
});
