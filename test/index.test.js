/**
 * Mock Tests for Video Call Interview Backend
 * (Socket.IO Signaling + Google Cloud STT + Translation)
 *
 * Tests cover:
 *  1. Utility / validation helpers
 *  2. Socket middleware (callerId auth)
 *  3. Call signaling events (makeCall, answerCall, endCall, IceCandidate)
 *  4. Audio recording pipeline (audioRecording -> STT -> Translation -> sttResult)
 *  5. Rate-limiting & back-pressure
 *  6. Edge cases and error handling
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock Google Cloud Speech
const mockRecognize = jest.fn();
jest.mock("@google-cloud/speech", () => ({
  SpeechClient: jest.fn().mockImplementation(() => ({
    recognize: mockRecognize,
  })),
}));

// Mock Google Cloud Translation
const mockTranslateText = jest.fn();
jest.mock("@google-cloud/translate", () => ({
  v3: {
    TranslationServiceClient: jest.fn().mockImplementation(() => ({
      translateText: mockTranslateText,
    })),
  },
}));

// Mock dotenv & fs so the module loads without real credentials
jest.mock("dotenv", () => ({ config: jest.fn() }));

const { Server } = require("socket.io");
const { createServer } = require("http");
const { io: ioClient } = require("socket.io-client");

// ─── Helpers extracted from source for unit-testing ──────────────────────────

// Re-implement pure helpers so we can test them in isolation without loading the
// full server module (which has side-effects).

const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const isValidLanguageCode = (languageCode) =>
  typeof languageCode === "string" &&
  /^[a-z]{2,3}(?:-[A-Za-z]{2,8})*$/i.test(languageCode.trim());

const normalizeTranslationLanguageCode = (languageCode) => {
  if (!languageCode) return "en";
  const normalized = String(languageCode).trim().toLowerCase();
  if (normalized.startsWith("my")) return "my";
  if (normalized.startsWith("en")) return "en";
  return normalized.split("-")[0];
};

const resolveTargetLanguage = (sourceLanguageCode, requestedTargetLanguage) => {
  if (isValidLanguageCode(requestedTargetLanguage)) {
    const normalizedRequested = normalizeTranslationLanguageCode(
      requestedTargetLanguage
    );
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
    if (!normalized) throw new Error("Empty audio payload");
    if (!/^[A-Za-z0-9+/=]+$/.test(normalized))
      throw new Error("Audio payload is not valid base64");
    return normalized;
  }
  if (Buffer.isBuffer(audio)) return audio.toString("base64");
  if (audio instanceof Uint8Array || Array.isArray(audio))
    return Buffer.from(audio).toString("base64");
  throw new Error("Unsupported audio payload type");
};

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

// ─── Unit Tests: Utility Helpers ─────────────────────────────────────────────

describe("isNonEmptyString", () => {
  test("returns true for non-empty strings", () => {
    expect(isNonEmptyString("hello")).toBe(true);
    expect(isNonEmptyString("  a  ")).toBe(true);
  });

  test("returns false for empty / whitespace-only strings", () => {
    expect(isNonEmptyString("")).toBe(false);
    expect(isNonEmptyString("   ")).toBe(false);
  });

  test("returns false for non-string types", () => {
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(123)).toBe(false);
    expect(isNonEmptyString({})).toBe(false);
  });
});

describe("isValidLanguageCode", () => {
  test("accepts valid BCP-47 codes", () => {
    expect(isValidLanguageCode("en")).toBe(true);
    expect(isValidLanguageCode("en-US")).toBe(true);
    expect(isValidLanguageCode("my-MM")).toBe(true);
    expect(isValidLanguageCode("zh-Hans-CN")).toBe(true);
  });

  test("rejects invalid codes", () => {
    expect(isValidLanguageCode("")).toBe(false);
    expect(isValidLanguageCode("e")).toBe(false);
    expect(isValidLanguageCode("123")).toBe(false);
    expect(isValidLanguageCode(null)).toBe(false);
    expect(isValidLanguageCode(undefined)).toBe(false);
  });
});

describe("normalizeTranslationLanguageCode", () => {
  test("normalizes English variants to 'en'", () => {
    expect(normalizeTranslationLanguageCode("en")).toBe("en");
    expect(normalizeTranslationLanguageCode("en-US")).toBe("en");
    expect(normalizeTranslationLanguageCode("EN-GB")).toBe("en");
  });

  test("normalizes Myanmar variants to 'my'", () => {
    expect(normalizeTranslationLanguageCode("my")).toBe("my");
    expect(normalizeTranslationLanguageCode("my-MM")).toBe("my");
  });

  test("defaults to 'en' for falsy input", () => {
    expect(normalizeTranslationLanguageCode(null)).toBe("en");
    expect(normalizeTranslationLanguageCode(undefined)).toBe("en");
    expect(normalizeTranslationLanguageCode("")).toBe("en");
  });

  test("extracts base language for unknown codes", () => {
    expect(normalizeTranslationLanguageCode("ja-JP")).toBe("ja");
    expect(normalizeTranslationLanguageCode("fr")).toBe("fr");
  });
});

describe("resolveTargetLanguage", () => {
  test("returns requested target when valid and supported", () => {
    expect(resolveTargetLanguage("en-US", "my")).toBe("my");
    expect(resolveTargetLanguage("my-MM", "en")).toBe("en");
  });

  test("auto-flips EN->MY and MY->EN when target is invalid", () => {
    expect(resolveTargetLanguage("en-US", null)).toBe("my");
    expect(resolveTargetLanguage("my-MM", null)).toBe("en");
  });

  test("auto-flips when requested target is unsupported (e.g. ja)", () => {
    expect(resolveTargetLanguage("en-US", "ja")).toBe("my");
    expect(resolveTargetLanguage("my-MM", "fr")).toBe("en");
  });
});

describe("normalizeAudioToBase64", () => {
  const validB64 = Buffer.from("hello world").toString("base64");

  test("handles plain base64 string", () => {
    expect(normalizeAudioToBase64(validB64)).toBe(validB64);
  });

  test("strips data-URI prefix", () => {
    const dataUri = `data:audio/wav;base64,${validB64}`;
    expect(normalizeAudioToBase64(dataUri)).toBe(validB64);
  });

  test("handles Buffer input", () => {
    const buf = Buffer.from("hello world");
    expect(normalizeAudioToBase64(buf)).toBe(validB64);
  });

  test("handles Uint8Array input", () => {
    const arr = new Uint8Array(Buffer.from("hello world"));
    expect(normalizeAudioToBase64(arr)).toBe(validB64);
  });

  test("throws on empty string", () => {
    expect(() => normalizeAudioToBase64("")).toThrow("Empty audio payload");
  });

  test("throws on invalid base64 string", () => {
    expect(() => normalizeAudioToBase64("!!!not-base64!!!")).toThrow(
      "not valid base64"
    );
  });

  test("throws on unsupported type", () => {
    expect(() => normalizeAudioToBase64(12345)).toThrow(
      "Unsupported audio payload type"
    );
    expect(() => normalizeAudioToBase64(null)).toThrow();
  });
});

describe("ALLOWED_ENCODINGS", () => {
  test("includes expected audio encoding formats", () => {
    expect(ALLOWED_ENCODINGS.has("LINEAR16")).toBe(true);
    expect(ALLOWED_ENCODINGS.has("WEBM_OPUS")).toBe(true);
    expect(ALLOWED_ENCODINGS.has("OGG_OPUS")).toBe(true);
    expect(ALLOWED_ENCODINGS.has("FLAC")).toBe(true);
    expect(ALLOWED_ENCODINGS.has("MULAW")).toBe(true);
  });

  test("rejects unknown encodings", () => {
    expect(ALLOWED_ENCODINGS.has("MP3")).toBe(false);
    expect(ALLOWED_ENCODINGS.has("AAC")).toBe(false);
  });
});

// ─── Integration Tests: Socket.IO Server ─────────────────────────────────────

describe("Socket.IO Server Integration", () => {
  let httpServer;
  let ioServer;
  let port;

  beforeAll((done) => {
    // Set env for tests
    process.env.GOOGLE_CLOUD_PROJECT_ID = "test-project";

    httpServer = createServer();
    ioServer = new Server(httpServer, {
      cors: { origin: "*", methods: ["GET", "POST"] },
    });

    // ── Reproduce middleware from source ──
    ioServer.use((socket, next) => {
      const callerId = socket.handshake?.query?.callerId;
      if (typeof callerId !== "string" || !callerId.trim()) {
        next(new Error("callerId query parameter is required"));
        return;
      }
      socket.user = callerId.trim();
      next();
    });

    // ── Reproduce event handlers ──
    ioServer.on("connection", (socket) => {
      socket.join(socket.user);
      socket.data.sttRateTimestamps = [];
      socket.data.sttQueue = Promise.resolve();
      socket.data.pendingSttRequests = 0;

      socket.on("makeCall", (data) => {
        if (!data || !data.calleeId || !data.sdpOffer) {
          socket.emit("signalError", {
            code: "INVALID_MAKE_CALL_PAYLOAD",
            message: "calleeId and sdpOffer are required",
          });
          return;
        }
        socket.to(data.calleeId.trim()).emit("newCall", {
          callerId: socket.user,
          sdpOffer: data.sdpOffer,
        });
      });

      socket.on("answerCall", (data) => {
        if (!data || !data.callerId || !data.sdpAnswer) {
          socket.emit("signalError", {
            code: "INVALID_ANSWER_CALL_PAYLOAD",
            message: "callerId and sdpAnswer are required",
          });
          return;
        }
        socket.to(data.callerId.trim()).emit("callAnswered", {
          callee: socket.user,
          sdpAnswer: data.sdpAnswer,
        });
      });

      socket.on("endCall", (data) => {
        if (!data || !data.calleeId) {
          socket.emit("signalError", {
            code: "INVALID_END_CALL_PAYLOAD",
            message: "calleeId is required",
          });
          return;
        }
        socket.to(data.calleeId.trim()).emit("callEnded", { from: socket.user });
        socket.emit("leaveCall", { to: data.calleeId });
      });

      socket.on("IceCandidate", (data) => {
        if (!data || !data.calleeId || data.iceCandidate == null) {
          socket.emit("signalError", {
            code: "INVALID_ICE_CANDIDATE_PAYLOAD",
            message: "calleeId and iceCandidate are required",
          });
          return;
        }
        socket.to(data.calleeId.trim()).emit("IceCandidate", {
          sender: socket.user,
          iceCandidate: data.iceCandidate,
        });
      });

      socket.on("audioRecording", async (data) => {
        const MAX_STT_PENDING = 8;
        if (socket.data.pendingSttRequests >= MAX_STT_PENDING) {
          socket.emit("sttError", {
            code: "STT_BACKPRESSURE",
            message: "Too many queued audio chunks",
          });
          return;
        }

        socket.data.pendingSttRequests += 1;

        socket.data.sttQueue = socket.data.sttQueue
          .then(async () => {
            // Validate payload
            if (!data || !data.to || !data.audio) {
              socket.emit("sttError", {
                code: "STT_INVALID_PAYLOAD",
                message: "Missing required fields",
              });
              return;
            }

            try {
              const audioBase64 =
                typeof data.audio === "string"
                  ? data.audio
                  : Buffer.from(data.audio).toString("base64");

              const [sttResponse] = await mockRecognize({
                config: {
                  encoding: data.encoding || "LINEAR16",
                  sampleRateHertz: data.sampleRateHertz || 16000,
                  languageCode: data.language || "en-US",
                  enableAutomaticPunctuation: true,
                },
                audio: { content: audioBase64 },
              });

              const transcription = (sttResponse.results || [])
                .map((r) => r.alternatives?.[0]?.transcript || "")
                .join(" ")
                .trim();

              if (!transcription) return;

              let translatedText = transcription;
              const sourceLanguageCode = normalizeTranslationLanguageCode(
                data.language
              );
              const targetLanguageCode = resolveTargetLanguage(
                data.language,
                data.targetLanguage
              );

              if (sourceLanguageCode !== targetLanguageCode) {
                const [translationResponse] = await mockTranslateText({
                  parent: `projects/test-project/locations/global`,
                  contents: [transcription],
                  mimeType: "text/plain",
                  sourceLanguageCode,
                  targetLanguageCode,
                });
                translatedText =
                  translationResponse?.translations?.[0]?.translatedText ||
                  transcription;
              }

              socket.to(data.to.trim()).emit("sttResult", {
                text: transcription,
                translated: translatedText,
                from: socket.user,
                to: data.to.trim(),
                sequenceId: data.sequenceId ?? null,
              });
            } catch (err) {
              socket.emit("sttError", {
                code: "STT_PROCESSING_FAILED",
                message: "Unable to process this audio chunk",
              });
            }
          })
          .finally(() => {
            socket.data.pendingSttRequests = Math.max(
              0,
              socket.data.pendingSttRequests - 1
            );
          });
      });
    });

    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  afterAll((done) => {
    ioServer.close();
    httpServer.close(done);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Helper to create a connected client
  function createClient(callerId) {
    return ioClient(`http://localhost:${port}`, {
      transports: ["websocket"],
      query: { callerId },
    });
  }

  // Wait for a socket event with timeout
  function waitForEvent(socket, event, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timeout waiting for '${event}'`)),
        timeoutMs
      );
      socket.once(event, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  // ─── Middleware Tests ──────────────────────────────────────────────────────

  describe("Middleware: callerId validation", () => {
    test("rejects connection without callerId", (done) => {
      const client = ioClient(`http://localhost:${port}`, {
        transports: ["websocket"],
        query: {},
      });

      client.on("connect_error", (err) => {
        expect(err.message).toContain("callerId");
        client.close();
        done();
      });
    });

    test("rejects connection with empty callerId", (done) => {
      const client = ioClient(`http://localhost:${port}`, {
        transports: ["websocket"],
        query: { callerId: "   " },
      });

      client.on("connect_error", (err) => {
        expect(err.message).toContain("callerId");
        client.close();
        done();
      });
    });

    test("accepts connection with valid callerId", (done) => {
      const client = createClient("test-user-123");
      client.on("connect", () => {
        expect(client.connected).toBe(true);
        client.close();
        done();
      });
    });
  });

  // ─── Call Signaling Tests ──────────────────────────────────────────────────

  describe("Call Signaling: makeCall", () => {
    test("employer makes call and helper receives newCall", (done) => {
      const employer = createClient("employer-1");
      const helper = createClient("helper-1");

      let connected = 0;
      const onBothConnected = () => {
        connected++;
        if (connected < 2) return;

        helper.on("newCall", (data) => {
          expect(data.callerId).toBe("employer-1");
          expect(data.sdpOffer).toBe("mock-sdp-offer");
          employer.close();
          helper.close();
          done();
        });

        employer.emit("makeCall", {
          calleeId: "helper-1",
          sdpOffer: "mock-sdp-offer",
        });
      };

      employer.on("connect", onBothConnected);
      helper.on("connect", onBothConnected);
    });

    test("emits signalError when calleeId is missing", (done) => {
      const client = createClient("employer-2");
      client.on("connect", () => {
        client.on("signalError", (data) => {
          expect(data.code).toBe("INVALID_MAKE_CALL_PAYLOAD");
          client.close();
          done();
        });

        client.emit("makeCall", { sdpOffer: "offer" });
      });
    });

    test("emits signalError when sdpOffer is missing", (done) => {
      const client = createClient("employer-3");
      client.on("connect", () => {
        client.on("signalError", (data) => {
          expect(data.code).toBe("INVALID_MAKE_CALL_PAYLOAD");
          client.close();
          done();
        });

        client.emit("makeCall", { calleeId: "helper-x" });
      });
    });
  });

  describe("Call Signaling: answerCall", () => {
    test("helper answers and employer receives callAnswered", (done) => {
      const employer = createClient("emp-answer-1");
      const helper = createClient("hlp-answer-1");

      let connected = 0;
      const onBothConnected = () => {
        connected++;
        if (connected < 2) return;

        employer.on("callAnswered", (data) => {
          expect(data.callee).toBe("hlp-answer-1");
          expect(data.sdpAnswer).toBe("mock-sdp-answer");
          employer.close();
          helper.close();
          done();
        });

        helper.emit("answerCall", {
          callerId: "emp-answer-1",
          sdpAnswer: "mock-sdp-answer",
        });
      };

      employer.on("connect", onBothConnected);
      helper.on("connect", onBothConnected);
    });

    test("emits signalError when callerId is missing", (done) => {
      const client = createClient("hlp-answer-2");
      client.on("connect", () => {
        client.on("signalError", (data) => {
          expect(data.code).toBe("INVALID_ANSWER_CALL_PAYLOAD");
          client.close();
          done();
        });

        client.emit("answerCall", { sdpAnswer: "answer" });
      });
    });
  });

  describe("Call Signaling: endCall", () => {
    test("employer ends call and helper receives callEnded", (done) => {
      const employer = createClient("emp-end-1");
      const helper = createClient("hlp-end-1");

      let connected = 0;
      const onBothConnected = () => {
        connected++;
        if (connected < 2) return;

        helper.on("callEnded", (data) => {
          expect(data.from).toBe("emp-end-1");
          employer.close();
          helper.close();
          done();
        });

        employer.emit("endCall", { calleeId: "hlp-end-1" });
      };

      employer.on("connect", onBothConnected);
      helper.on("connect", onBothConnected);
    });

    test("employer receives leaveCall after ending", (done) => {
      const employer = createClient("emp-end-2");

      employer.on("connect", () => {
        employer.on("leaveCall", (data) => {
          expect(data.to).toBe("hlp-end-2");
          employer.close();
          done();
        });

        employer.emit("endCall", { calleeId: "hlp-end-2" });
      });
    });

    test("emits signalError when calleeId is missing", (done) => {
      const client = createClient("emp-end-3");
      client.on("connect", () => {
        client.on("signalError", (data) => {
          expect(data.code).toBe("INVALID_END_CALL_PAYLOAD");
          client.close();
          done();
        });

        client.emit("endCall", {});
      });
    });
  });

  describe("Call Signaling: IceCandidate", () => {
    test("forwards ICE candidate to the correct peer", (done) => {
      const employer = createClient("emp-ice-1");
      const helper = createClient("hlp-ice-1");

      let connected = 0;
      const onBothConnected = () => {
        connected++;
        if (connected < 2) return;

        helper.on("IceCandidate", (data) => {
          expect(data.sender).toBe("emp-ice-1");
          expect(data.iceCandidate).toEqual({ candidate: "mock-candidate" });
          employer.close();
          helper.close();
          done();
        });

        employer.emit("IceCandidate", {
          calleeId: "hlp-ice-1",
          iceCandidate: { candidate: "mock-candidate" },
        });
      };

      employer.on("connect", onBothConnected);
      helper.on("connect", onBothConnected);
    });

    test("emits signalError when iceCandidate is null", (done) => {
      const client = createClient("emp-ice-2");
      client.on("connect", () => {
        client.on("signalError", (data) => {
          expect(data.code).toBe("INVALID_ICE_CANDIDATE_PAYLOAD");
          client.close();
          done();
        });

        client.emit("IceCandidate", {
          calleeId: "hlp-ice-2",
          iceCandidate: null,
        });
      });
    });
  });

  // ─── Audio Recording / STT / Translation Pipeline ─────────────────────────

  describe("audioRecording -> STT -> Translation pipeline", () => {
    test("processes audio, transcribes, translates, and emits sttResult", (done) => {
      const audioBase64 = Buffer.from("fake-audio-data").toString("base64");

      // Mock STT: returns "Hello, how are you?"
      mockRecognize.mockResolvedValueOnce([
        {
          results: [
            { alternatives: [{ transcript: "Hello, how are you?" }] },
          ],
        },
      ]);

      // Mock Translation: EN -> MY
      mockTranslateText.mockResolvedValueOnce([
        {
          translations: [{ translatedText: "မင်္ဂလာပါ၊ နေကောင်းလား?" }],
        },
      ]);

      const sender = createClient("sender-stt-1");
      const receiver = createClient("receiver-stt-1");

      let connected = 0;
      const onBothConnected = () => {
        connected++;
        if (connected < 2) return;

        receiver.on("sttResult", (data) => {
          expect(data.text).toBe("Hello, how are you?");
          expect(data.translated).toBe("မင်္ဂလာပါ၊ နေကောင်းလား?");
          expect(data.from).toBe("sender-stt-1");
          expect(data.to).toBe("receiver-stt-1");
          sender.close();
          receiver.close();
          done();
        });

        sender.emit("audioRecording", {
          to: "receiver-stt-1",
          audio: audioBase64,
          language: "en-US",
          targetLanguage: "my",
          encoding: "LINEAR16",
          sampleRateHertz: 16000,
          sequenceId: 1,
        });
      };

      sender.on("connect", onBothConnected);
      receiver.on("connect", onBothConnected);
    });

    test("skips translation when source and target language are the same", (done) => {
      const audioBase64 = Buffer.from("fake-audio").toString("base64");

      mockRecognize.mockResolvedValueOnce([
        {
          results: [{ alternatives: [{ transcript: "No translation needed" }] }],
        },
      ]);

      const sender = createClient("sender-stt-same");
      const receiver = createClient("receiver-stt-same");

      let connected = 0;
      const onBothConnected = () => {
        connected++;
        if (connected < 2) return;

        receiver.on("sttResult", (data) => {
          expect(data.text).toBe("No translation needed");
          // Translation should be the same as text since EN->EN
          expect(data.translated).toBe("No translation needed");
          expect(mockTranslateText).not.toHaveBeenCalled();
          sender.close();
          receiver.close();
          done();
        });

        sender.emit("audioRecording", {
          to: "receiver-stt-same",
          audio: audioBase64,
          language: "en-US",
          targetLanguage: "en",
          encoding: "LINEAR16",
          sampleRateHertz: 16000,
        });
      };

      sender.on("connect", onBothConnected);
      receiver.on("connect", onBothConnected);
    });

    test("emits sttError when STT processing fails", (done) => {
      const audioBase64 = Buffer.from("bad-audio").toString("base64");

      mockRecognize.mockRejectedValueOnce(new Error("STT service unavailable"));

      const sender = createClient("sender-stt-err");

      sender.on("connect", () => {
        sender.on("sttError", (data) => {
          expect(data.code).toBe("STT_PROCESSING_FAILED");
          expect(data.message).toBe("Unable to process this audio chunk");
          sender.close();
          done();
        });

        sender.emit("audioRecording", {
          to: "receiver-stt-err",
          audio: audioBase64,
          language: "en-US",
          encoding: "LINEAR16",
          sampleRateHertz: 16000,
        });
      });
    });

    test("emits sttError for invalid payload (missing audio)", (done) => {
      const sender = createClient("sender-stt-invalid");

      sender.on("connect", () => {
        sender.on("sttError", (data) => {
          expect(data.code).toBe("STT_INVALID_PAYLOAD");
          sender.close();
          done();
        });

        sender.emit("audioRecording", {
          to: "receiver-stt-invalid",
          // missing audio field
        });
      });
    });

    test("does not emit sttResult when transcription is empty", (done) => {
      const audioBase64 = Buffer.from("silent-audio").toString("base64");

      mockRecognize.mockResolvedValueOnce([{ results: [] }]);

      const sender = createClient("sender-stt-empty");
      const receiver = createClient("receiver-stt-empty");

      let connected = 0;
      const onBothConnected = () => {
        connected++;
        if (connected < 2) return;

        // Should NOT receive sttResult for empty transcription
        let received = false;
        receiver.on("sttResult", () => {
          received = true;
        });

        sender.emit("audioRecording", {
          to: "receiver-stt-empty",
          audio: audioBase64,
          language: "en-US",
          encoding: "LINEAR16",
          sampleRateHertz: 16000,
        });

        // Wait a bit and verify no result was emitted
        setTimeout(() => {
          expect(received).toBe(false);
          sender.close();
          receiver.close();
          done();
        }, 500);
      };

      sender.on("connect", onBothConnected);
      receiver.on("connect", onBothConnected);
    });
  });

  // ─── Back-pressure Tests ───────────────────────────────────────────────────

  describe("Back-pressure and rate limiting", () => {
    test("emits STT_BACKPRESSURE when too many pending requests", (done) => {
      const audioBase64 = Buffer.from("audio").toString("base64");

      // Make mockRecognize take forever so requests pile up
      mockRecognize.mockImplementation(
        () => new Promise(() => {}) // never resolves
      );

      const sender = createClient("sender-bp");

      sender.on("connect", () => {
        let backpressureReceived = false;

        sender.on("sttError", (data) => {
          if (data.code === "STT_BACKPRESSURE") {
            backpressureReceived = true;
            expect(data.message).toBe("Too many queued audio chunks");
            sender.close();
            done();
          }
        });

        // Send more than MAX_STT_PENDING_REQUESTS (8) audio chunks rapidly
        for (let i = 0; i < 12; i++) {
          sender.emit("audioRecording", {
            to: "receiver-bp",
            audio: audioBase64,
            language: "en-US",
            encoding: "LINEAR16",
            sampleRateHertz: 16000,
            sequenceId: i,
          });
        }
      });
    });
  });

  // ─── Myanmar to English Translation ────────────────────────────────────────

  describe("Myanmar (my) to English (en) translation", () => {
    test("processes Myanmar audio and translates to English", (done) => {
      const audioBase64 = Buffer.from("myanmar-audio").toString("base64");

      mockRecognize.mockResolvedValueOnce([
        {
          results: [
            { alternatives: [{ transcript: "မင်္ဂလာပါ" }] },
          ],
        },
      ]);

      mockTranslateText.mockResolvedValueOnce([
        {
          translations: [{ translatedText: "Hello" }],
        },
      ]);

      const sender = createClient("sender-my");
      const receiver = createClient("receiver-my");

      let connected = 0;
      const onBothConnected = () => {
        connected++;
        if (connected < 2) return;

        receiver.on("sttResult", (data) => {
          expect(data.text).toBe("မင်္ဂလာပါ");
          expect(data.translated).toBe("Hello");
          expect(data.from).toBe("sender-my");
          sender.close();
          receiver.close();
          done();
        });

        sender.emit("audioRecording", {
          to: "receiver-my",
          audio: audioBase64,
          language: "my-MM",
          targetLanguage: "en",
          encoding: "LINEAR16",
          sampleRateHertz: 16000,
        });
      };

      sender.on("connect", onBothConnected);
      receiver.on("connect", onBothConnected);
    });
  });
});
