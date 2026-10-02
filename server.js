const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;

// --------------------------------------------------
// CORS
// --------------------------------------------------
app.use(cors());

// --------------------------------------------------
// Rate Limiting
// 10 requests per minute per IP
// --------------------------------------------------
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

app.use("/video", limiter);

// --------------------------------------------------
// HOME
// --------------------------------------------------
app.get("/", (req, res) => {
  res.json({
    status: "success",
    service: "NetSaves API",
    message: "NetSaves downloader backend is online."
  });
});

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    status: "success"
  });
});

// --------------------------------------------------
// VERSION / SERVER DIAGNOSTICS
// --------------------------------------------------
app.get("/version", (req, res) => {
  getCommandOutput("yt-dlp", ["--version"], (ytDlpResult) => {
    getCommandOutput("ffmpeg", ["-version"], (ffmpegResult) => {
      let ffmpegVersion = "";

      if (ffmpegResult.output) {
        const match = ffmpegResult.output.match(
          /ffmpeg version\s+([^\s]+)/
        );

        if (match) {
          ffmpegVersion = match[1];
        }
      }

      res.json({
        status: "success",

        yt_dlp: {
          installed: ytDlpResult.code === 0,
          version: ytDlpResult.output.trim(),
          exit_code: ytDlpResult.code
        },

        ffmpeg: {
          installed: ffmpegResult.code === 0,
          version: ffmpegVersion,
          exit_code: ffmpegResult.code
        }
      });
    });
  });
});

// --------------------------------------------------
// VIDEO DOWNLOADER
// --------------------------------------------------
app.get("/video", (req, res) => {
  const url = req.query.url;

  // Check URL
  if (!url) {
    return res.status(400).json({
      status: "error",
      error: "Missing video URL. Use /video?url=YOUR_VIDEO_URL"
    });
  }

  // Basic URL validation
  let parsedUrl;

  try {
    parsedUrl = new URL(url);
  } catch (error) {
    return res.status(400).json({
      status: "error",
      error: "Invalid video URL."
    });
  }

  // Only allow HTTP/HTTPS URLs
  if (
    parsedUrl.protocol !== "http:" &&
    parsedUrl.protocol !== "https:"
  ) {
    return res.status(400).json({
      status: "error",
      error: "Only HTTP and HTTPS URLs are supported."
    });
  }

  // ------------------------------------------------
  // yt-dlp arguments
  // ------------------------------------------------
  const args = [
    "--dump-single-json",
    "--no-warnings",
    "--no-playlist",
    "--skip-download",

    // Use Deno for YouTube JavaScript challenges
    "--js-runtimes",
    "deno",

    url
  ];

  // ------------------------------------------------
  // Run yt-dlp
  // ------------------------------------------------
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
      error: `Failed to start yt-dlp: ${error.message}`
    });
  });

  process.on("close", (code) => {
    // ------------------------------------------------
    // yt-dlp failed
    // ------------------------------------------------
    if (code !== 0) {
      return res.status(500).json({
        status: "error",
        error: stderr.trim() || "yt-dlp failed to process the video.",
        exit_code: code
      });
    }

    // ------------------------------------------------
    // Parse yt-dlp JSON
    // ------------------------------------------------
    try {
      const data = JSON.parse(stdout);

      // Return useful information to frontend
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
              .filter((format) => {
                return (
                  format.url &&
                  (
                    format.ext === "mp4" ||
                    format.ext === "webm" ||
                    format.ext === "m4a"
                  )
                );
              })
              .map((format) => ({
                url: format.url,
                format_id: format.format_id || "",
                ext: format.ext || "",
                resolution: format.resolution || "",
                width: format.width || null,
                height: format.height || null,
                fps: format.fps || null,
                filesize: format.filesize || format.filesize_approx || null,
                tbr: format.tbr || null,
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

// --------------------------------------------------
// COMMAND HELPER
// --------------------------------------------------
function getCommandOutput(command, args, callback) {
  const process = spawn(command, args);

  let output = "";
  let errorOutput = "";

  process.stdout.on("data", (data) => {
    output += data.toString();
  });

  process.stderr.on("data", (data) => {
    errorOutput += data.toString();
  });

  process.on("error", () => {
    callback({
      code: -1,
      output: "",
      error: errorOutput
    });
  });

  process.on("close", (code) => {
    callback({
      code,
      output: output || errorOutput,
      error: errorOutput
    });
  });
}

// --------------------------------------------------
// START SERVER
// --------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`NetSaves API running on port ${PORT}`);
});
