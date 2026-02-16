const { Server } = require("socket.io");
const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);

require("dotenv").config();
const path = require("path");
const fs = require("fs");

const speech = require("@google-cloud/speech");
const { TranslationServiceClient } = require("@google-cloud/translate").v3;
const translationClient = new TranslationServiceClient(); // V3 client

const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES || 1024 * 1024);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 20);
const MAX_STT_PENDING_REQUESTS = Number(
  process.env.MAX_STT_PENDING_REQUESTS || 8
);
const ALLOWED_ENCODINGS = new Set([
  "LINEAR16",
  "WEBM_OPUS",
  "OGG_OPUS",
  "FLAC",
  "MULAW",
  "AMR",
  "AMR_WB",
  "SPEEX_WITH_HEADER_BYTE",
]);

// If running locally with .env
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
}

// If running in Railway with BASE64 encoded key
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64) {
  try {
    const decodedKey = Buffer.from(
      process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64,
      "base64"
    ).toString("utf8");
    JSON.parse(decodedKey);

    const keyPath = "/tmp/speech-key.json";
    fs.writeFileSync(keyPath, decodedKey, { mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
  } catch (credentialError) {
    console.error("Invalid GOOGLE_APPLICATION_CREDENTIALS_BASE64");
    process.exit(1);
  }
}

const client = new speech.SpeechClient(); // for STT
const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
const location = "global"; // V3 translation client location

const IO = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const emitSttError = (socket, code, message, extra = {}) => {
  socket.emit("sttError", {
    code,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  });
};

const emitSignalError = (socket, code, message, extra = {}) => {
  socket.emit("signalError", {
    code,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  });
};

const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const getRequiredString = (data, key, errorMessage) => {
  if (!data || typeof data !== "object" || !isNonEmptyString(data[key])) {
    throw new Error(errorMessage);
  }
  return data[key].trim();
};

const isValidLanguageCode = (languageCode) =>
  typeof languageCode === "string" &&
  /^[a-z]{2,3}(?:-[A-Za-z]{2,8})*$/i.test(languageCode.trim());

const normalizeTranslationLanguageCode = (languageCode) => {
  if (!languageCode) {
    return "en";
  }

  const normalized = String(languageCode).trim().toLowerCase();
  if (normalized.startsWith("my")) {
    return "my";
  }
  if (normalized.startsWith("en")) {
    return "en";
  }
  return normalized.split("-")[0];
};

const resolveTargetLanguage = (sourceLanguageCode, requestedTargetLanguage) => {
  if (isValidLanguageCode(requestedTargetLanguage)) {
    const normalizedRequested =
      normalizeTranslationLanguageCode(requestedTargetLanguage);
    // Current production support scope for translation in this app is EN<->MY.
    if (normalizedRequested === "en" || normalizedRequested === "my") {
      return normalizedRequested;
    }
  }

  const source = normalizeTranslationLanguageCode(sourceLanguageCode);
  return source === "en" ? "my" : "en";
};

const normalizeAudioToBase64 = (audio) => {
  if (typeof audio === "string") {
    const withoutPrefix = audio.startsWith("data:")
      ? audio.slice(audio.indexOf(",") + 1)
      : audio;
    const normalized = withoutPrefix.replace(/\s/g, "");
    if (!normalized) {
      throw new Error("Empty audio payload");
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) {
      throw new Error("Audio payload is not valid base64");
    }
    return normalized;
  }

  if (Buffer.isBuffer(audio)) {
    return audio.toString("base64");
  }

  if (audio instanceof Uint8Array || Array.isArray(audio)) {
    return Buffer.from(audio).toString("base64");
  }

  throw new Error("Unsupported audio payload type");
};

const isRateLimited = (socket) => {
  const now = Date.now();
  const recentTimestamps = (socket.data.sttRateTimestamps || []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS
  );

  if (recentTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    socket.data.sttRateTimestamps = recentTimestamps;
    return true;
  }

  recentTimestamps.push(now);
  socket.data.sttRateTimestamps = recentTimestamps;
  return false;
};

const parseAudioPayload = (data) => {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid payload");
  }

  if (typeof data.to !== "string" || !data.to.trim()) {
    throw new Error("Missing recipient id");
  }

  const sourceLanguageCode = isValidLanguageCode(data.language)
    ? data.language.trim()
    : "en-US";
  const targetLanguageCode = resolveTargetLanguage(
    sourceLanguageCode,
    data.targetLanguage
  );

  const normalizedEncoding =
    typeof data.encoding === "string"
      ? data.encoding.trim().toUpperCase()
      : undefined;
  const encoding = ALLOWED_ENCODINGS.has(normalizedEncoding)
    ? normalizedEncoding
    : "LINEAR16";

  const sampleRateHertz = Number(data.sampleRateHertz || 16000);
  if (
    Number.isNaN(sampleRateHertz) ||
    sampleRateHertz < 8000 ||
    sampleRateHertz > 48000
  ) {
    throw new Error("Invalid sample rate");
  }

  const audioBase64 = normalizeAudioToBase64(data.audio);
  const audioSizeInBytes = Buffer.from(audioBase64, "base64").length;
  if (!audioSizeInBytes || audioSizeInBytes > MAX_AUDIO_BYTES) {
    throw new Error("Audio payload size is invalid");
  }

  return {
    audioBase64,
    sourceLanguageCode,
    targetLanguageCode,
    recipientId: data.to.trim(),
    sampleRateHertz,
    encoding,
    sequenceId: data.sequenceId ?? null,
  };
};

IO.use((socket, next) => {
  const callerId = socket.handshake?.query?.callerId;
  if (typeof callerId !== "string" || !callerId.trim()) {
    next(new Error("callerId query parameter is required"));
    return;
  }

  socket.user = callerId.trim();
  next();
});

IO.on("connection", (socket) => {
  console.log(socket.user, "Connected");
  socket.join(socket.user);
  socket.data.sttRateTimestamps = [];
  socket.data.sttQueue = Promise.resolve();
  socket.data.pendingSttRequests = 0;

  const runSafeHandler = (eventName, handler) => async (data) => {
    try {
      await handler(data);
    } catch (unhandledError) {
      console.error(`Unhandled error in event ${eventName}:`, {
        message: unhandledError.message,
        user: socket.user,
      });
      emitSignalError(
        socket,
        "UNHANDLED_SERVER_ERROR",
        `Unexpected server error in ${eventName}`
      );
    }
  };

  // --- Call signaling ---
  socket.on("makeCall", runSafeHandler("makeCall", async (data) => {
    let calleeId;
    let sdpOffer;
    try {
      calleeId = getRequiredString(data, "calleeId", "calleeId is required");
      sdpOffer = getRequiredString(data, "sdpOffer", "sdpOffer is required");
    } catch (validationError) {
      emitSignalError(socket, "INVALID_MAKE_CALL_PAYLOAD", validationError.message);
      return;
    }

    console.log(`Make Call: to${calleeId} from:${socket.user}`);
    socket.to(calleeId).emit("newCall", {
      callerId: socket.user,
      sdpOffer,
    });
  }));

  socket.on("answerCall", runSafeHandler("answerCall", async (data) => {
    let callerId;
    let sdpAnswer;
    try {
      callerId = getRequiredString(data, "callerId", "callerId is required");
      sdpAnswer = getRequiredString(data, "sdpAnswer", "sdpAnswer is required");
    } catch (validationError) {
      emitSignalError(
        socket,
        "INVALID_ANSWER_CALL_PAYLOAD",
        validationError.message
      );
      return;
    }

    socket.to(callerId).emit("callAnswered", {
      callee: socket.user,
      sdpAnswer,
    });
  }));

  socket.on("endCall", runSafeHandler("endCall", async (data) => {
    let calleeId;
    try {
      calleeId = getRequiredString(data, "calleeId", "calleeId is required");
    } catch (validationError) {
      emitSignalError(socket, "INVALID_END_CALL_PAYLOAD", validationError.message);
      return;
    }

    console.log(socket.user, "EndCallFrom", calleeId);
    socket.to(calleeId).emit("callEnded", { from: socket.user });
    socket.emit("leaveCall", { to: calleeId });
  }));

  socket.on("IceCandidate", runSafeHandler("IceCandidate", async (data) => {
    let calleeId;
    let iceCandidate;
    try {
      calleeId = getRequiredString(data, "calleeId", "calleeId is required");
      if (!data || typeof data !== "object" || data.iceCandidate == null) {
        throw new Error("iceCandidate is required");
      }
      iceCandidate = data.iceCandidate;
    } catch (validationError) {
      emitSignalError(
        socket,
        "INVALID_ICE_CANDIDATE_PAYLOAD",
        validationError.message
      );
      return;
    }

    socket.to(calleeId).emit("IceCandidate", {
      sender: socket.user,
      iceCandidate,
    });
  }));

  socket.on("audioRecording", runSafeHandler("audioRecording", async (data) => {
    if (socket.data.pendingSttRequests >= MAX_STT_PENDING_REQUESTS) {
      emitSttError(socket, "STT_BACKPRESSURE", "Too many queued audio chunks");
      return;
    }

    socket.data.pendingSttRequests += 1;

    socket.data.sttQueue = socket.data.sttQueue
      .then(async () => {
        if (isRateLimited(socket)) {
          emitSttError(
            socket,
            "STT_RATE_LIMITED",
            "Too many audio requests in a short time"
          );
          return;
        }

        let parsedPayload;
        try {
          parsedPayload = parseAudioPayload(data);
        } catch (validationError) {
          emitSttError(socket, "STT_INVALID_PAYLOAD", validationError.message);
          return;
        }

        const sttRequest = {
          config: {
            encoding: parsedPayload.encoding,
            sampleRateHertz: parsedPayload.sampleRateHertz,
            languageCode: parsedPayload.sourceLanguageCode,
            enableAutomaticPunctuation: true,
          },
          audio: {
            content: parsedPayload.audioBase64,
          },
        };

        try {
          const [sttResponse] = await client.recognize(sttRequest);
          const transcription = (sttResponse.results || [])
            .map((result) => result.alternatives?.[0]?.transcript || "")
            .join(" ")
            .trim();

          if (!transcription) {
            return;
          }

          let translatedText = transcription;
          const sourceLanguageCode = normalizeTranslationLanguageCode(
            parsedPayload.sourceLanguageCode
          );

          if (!projectId) {
            console.warn(
              "GOOGLE_CLOUD_PROJECT_ID is missing, skipping translation"
            );
          } else if (sourceLanguageCode !== parsedPayload.targetLanguageCode) {
            const translateRequest = {
              parent: `projects/${projectId}/locations/${location}`,
              contents: [transcription],
              mimeType: "text/plain",
              sourceLanguageCode,
              targetLanguageCode: parsedPayload.targetLanguageCode,
            };

            const [translationResponse] =
              await translationClient.translateText(translateRequest);
            translatedText =
              translationResponse?.translations?.[0]?.translatedText ||
              transcription;
          }

          const resultPayload = {
            text: transcription,
            translated: translatedText,
            from: socket.user,
            to: parsedPayload.recipientId,
            sequenceId: parsedPayload.sequenceId,
          };

          socket.to(parsedPayload.recipientId).emit("sttResult", resultPayload);
        } catch (processingError) {
          console.error("STT processing error:", {
            message: processingError.message,
            code: processingError.code,
            user: socket.user,
          });
          emitSttError(
            socket,
            "STT_PROCESSING_FAILED",
            "Unable to process this audio chunk"
          );
        }
      })
      .finally(() => {
        socket.data.pendingSttRequests = Math.max(
          0,
          socket.data.pendingSttRequests - 1
        );
      });
  }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.IO STT server running on port ${PORT}`);
});
