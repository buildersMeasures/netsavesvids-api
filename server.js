const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;

// ----------------------------------------
// CORS
// ----------------------------------------

app.use(cors());

app.use(express.json());

// ----------------------------------------
// Rate limiting
// 10 requests per minute per IP
// ----------------------------------------

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "error",
    error: "Too many requests. Try again later."
  }
});

app.use(limiter);

// ----------------------------------------
// Homepage
// ----------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "NetSaves Downloader API"
  });
});

// ----------------------------------------
// Health check
// ----------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok"
  });
});

// ----------------------------------------
// Validate URL
// ----------------------------------------

function validateVideoUrl(videoUrl) {
  try {
    const parsed = new URL(videoUrl);

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      return false;
    }

    return true;
  } catch (error) {
    return false;
  }
}

// ----------------------------------------
// Run yt-dlp
// ----------------------------------------

function getVideoInfo(videoUrl) {
  return new Promise((resolve, reject) => {

    const args = [
      "--no-warnings",
      "--no-playlist",
      "--dump-single-json",
      "--skip-download",
      "--format",
      "best[ext=mp4][acodec!=none][vcodec!=none]/best[ext=mp4]/best",
      videoUrl
    ];

    const ytdlp = spawn("yt-dlp", args);

    let output = "";
    let errorOutput = "";

    // ------------------------------------
    // Standard output
    // ------------------------------------

    ytdlp.stdout.on("data", (data) => {
      output += data.toString();
    });

    // ------------------------------------
    // Error output
    // ------------------------------------

    ytdlp.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    // ------------------------------------
    // Process error
    // ------------------------------------

    ytdlp.on("error", (error) => {
      reject(error.message);
    });

    // ------------------------------------
    // Process finished
    // ------------------------------------

    ytdlp.on("close", (code) => {

      if (code !== 0) {
        return reject(
          errorOutput.trim() ||
          "yt-dlp failed to process this URL."
        );
      }

      try {

        const data = JSON.parse(output);

        if (!data.url) {
          return reject(
            "No downloadable video format was found."
          );
        }

        resolve({
          title: data.title || "Video",
          thumbnail: data.thumbnail || "",
          duration: data.duration || 0,
          uploader: data.uploader || "",
          webpage_url: data.webpage_url || videoUrl,
          download_url: data.url,
          ext: data.ext || "mp4",
          filesize:
            data.filesize ||
            data.filesize_approx ||
            null
        });

      } catch (error) {

        reject(
          "Failed to process the media information."
        );
      }
    });
  });
}

// ----------------------------------------
// /video endpoint
// ----------------------------------------

app.get("/video", async (req, res) => {

  const videoUrl = req.query.url;

  // --------------------------------------
  // Check URL exists
  // --------------------------------------

  if (!videoUrl) {
    return res.status(400).json({
      status: "error",
      error: "Missing required parameter: url"
    });
  }

  // --------------------------------------
  // Check URL is valid
  // --------------------------------------

  if (!validateVideoUrl(videoUrl)) {
    return res.status(400).json({
      status: "error",
      error: "Invalid video URL."
    });
  }

  try {

    console.log("Processing:", videoUrl);

    const result = await getVideoInfo(videoUrl);

    res.json({
      status: "success",
      ...result
    });

  } catch (error) {

    console.error("yt-dlp error:", error);

    res.status(500).json({
      status: "error",
      error: error.toString()
    });
  }
});

// ----------------------------------------
// Start server
// ----------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `NetSaves API running on port ${PORT}`
  );
});
