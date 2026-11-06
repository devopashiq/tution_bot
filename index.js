const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require('qrcode');
const cfg = require("./config");
const { pushLog, setStatus, setQr, setInfo } = require('./botState');

// Start the dashboard web server alongside the bot
require('./server');

// ==================================================
// 1. CONFIGURATION
// ==================================================

const idOf = (id) => id && (id._serialized || id.$1);

const groups = new Set(cfg.GROUP_IDS);
const keywords = (cfg.KEYWORDS || []).map((k) => k.toLowerCase().trim());
const seen = new Set();
const MAX_SEEN = 500;

function loadPreferences() {
  // Reload the saved values so dashboard changes affect matching immediately.
  delete require.cache[require.resolve("./config")];
  const currentCfg = require("./config");
  const configuredWindows = Array.isArray(currentCfg.TIME_WINDOWS)
    ? currentCfg.TIME_WINDOWS
    : [{
        START_MINUTES: currentCfg.EARLIEST_START_MINUTES ?? 19 * 60,
        END_MINUTES: currentCfg.LATEST_END_MINUTES ?? 22 * 60,
      }];

  return {
    subjects: Array.isArray(currentCfg.SUBJECTS)
      ? currentCfg.SUBJECTS.map((subject) => String(subject).trim().toLowerCase())
      : ["english"],
    timeWindows: configuredWindows
      .filter((window) =>
        Number.isFinite(window?.START_MINUTES) &&
        Number.isFinite(window?.END_MINUTES) &&
        window.START_MINUTES >= 0 &&
        window.END_MINUTES < 24 * 60 &&
        window.START_MINUTES < window.END_MINUTES,
      )
      .map((window) => ({
        startMinutes: window.START_MINUTES,
        endMinutes: window.END_MINUTES,
      })),
    minimumClass: Number.isFinite(currentCfg.MINIMUM_CLASS) ? currentCfg.MINIMUM_CLASS : 8,
    availableDays: Array.isArray(currentCfg.AVAILABLE_DAYS)
      ? currentCfg.AVAILABLE_DAYS.map((day) => String(day).trim().toLowerCase())
      : ["monday", "tuesday", "wednesday", "thursday", "friday"],
  };
}

const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const DAY_ALIASES = {
  mon: "Monday",
  monday: "Monday",
  mndy: "Monday",
  tue: "Tuesday",
  tues: "Tuesday",
  tuesday: "Tuesday",
  wed: "Wednesday",
  wednesday: "Wednesday",
  thu: "Thursday",
  thur: "Thursday",
  thursday: "Thursday",
  fri: "Friday",
  friday: "Friday",
  sat: "Saturday",
  saturday: "Saturday",
  sun: "Sunday",
  sunday: "Sunday",
};

// ==================================================
// 2. WHATSAPP CLIENT
// ==================================================

function isWindowsFileLockError(error) {
  const details = `${error?.code || ''} ${error?.message || error || ''}`;
  return /\bEBUSY\b/i.test(details);
}

// LocalAuth deletes its session directory as soon as WhatsApp reports LOGOUT.
// On Windows, Chromium can still hold profile database files at that moment.
// Defer that cleanup until the browser has been closed by Disconnect/Reconnect.
class SafeLocalAuth extends LocalAuth {
  constructor(options) {
    super(options);
    this.cleanupPending = false;
  }

  async logout() {
    try {
      await super.logout();
      this.cleanupPending = false;
    } catch (error) {
      if (!isWindowsFileLockError(error)) throw error;
      this.cleanupPending = true;
      console.warn('[Auth] WhatsApp profile is still locked; session cleanup will retry after Chromium closes.');
    }
  }

  async retryPendingCleanup() {
    if (!this.cleanupPending) return true;
    try {
      await super.logout();
      this.cleanupPending = false;
      return true;
    } catch (error) {
      if (!isWindowsFileLockError(error)) throw error;
      console.warn('[Auth] WhatsApp profile is still locked; deferred cleanup remains pending.');
      return false;
    }
  }
}

const client = new Client({
  authStrategy: new SafeLocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  },
});

client.on("qr", async (qr) => {
  console.log("Scan this QR: WhatsApp > Linked Devices > Link a device");
  qrcode.generate(qr, { small: true });
  setStatus('qr');
  try {
    const dataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
    setQr(qr, dataUrl);
  } catch (e) {
    setQr(qr, null);
  }
  pushLog('info', 'QR code generated — scan to authenticate');
});

client.on("authenticated", () => {
  console.log("Authenticated");
  setStatus('authenticated');
  pushLog('success', 'WhatsApp authenticated successfully');
});

client.on("auth_failure", (m) => {
  console.error("Auth failure:", m);
  setStatus('auth_failure');
  pushLog('error', `Authentication failed: ${m}`);
});

client.on("disconnected", (r) => {
  console.log("Disconnected:", r);
  setStatus('disconnected');
  pushLog('warn', `Client disconnected: ${r}`);
});

client.on("ready", () => {
  console.log("Bot ready. Watching", groups.size, "group(s).");
  console.log("Subject preference:", preferences.subjects);
  console.log("Available from: 5:30 PM onwards");
  setStatus('ready');
  setInfo(client.info);
  pushLog('success', `Bot ready — watching ${groups.size} group(s)`);
  pushLog('info', `Subject filter: ${preferences.subjects.join(', ')}`);
  pushLog('info', 'Available from 5:30 PM onwards');
});

// ==================================================
// 3. NORMALIZE MESSAGE
// ==================================================

function normalizeMessage(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[*_~`]/g, "")
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]+/g, " "))
    .join("\n")
    .trim();
}

// ==================================================
// 4. EXTRACT LABELED FIELDS
// ==================================================

function extractFields(text) {
  const fields = {};
  let currentField = null;

  const aliases = {
    student: "student",
    name: "student",
    class: "class",
    grade: "class",
    course: "course",
    subject: "subject",
    session: "sessions",
    sessions: "sessions",
    time: "time",
    timing: "time",
    day: "days",
    days: "days",
  };

  

  for (const line of normalizeMessage(text).split("\n")) {
    const match = line.match(
      /^\s*(STUDENT|NAME|CLASS|GRADE|COURSE|SUBJECT|SESSIONS?|TIME|TIMING|DAYS?)\s*[:：-]\s*(.*?)\s*$/i,
    );

    if (match) {
      currentField = aliases[match[1].toLowerCase()];
      fields[currentField] = match[2].trim();
      continue;
    }

    // Some broadcasts put weekday names on the next line.
    if (
      currentField === "days" &&
      /\b(mon|monday|mndy|tue|tues|tuesday|wed|wednesday|thu|thur|thursday|fri|friday|sat|saturday|sun|sunday)\b/i.test(
        line,
      )
    ) {
      fields.days = `${fields.days} ${line}`.trim();
    }
  }

  return fields;
}

// ==================================================
// 5. PARSE A SINGLE TIME INTO MINUTES
// ==================================================

function parseTime(value, defaultPeriod = null) {
  if (!value) return null;

  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/\./g, ":")
    .replace(/\s+/g, "");

  const match = normalized.match(/^(\d{1,2})(?::(\d{1,2}))?(am|pm)?$/);

  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const period = match[3] || defaultPeriod;

  if (hour < 1 || hour > 12 || minute > 59 || !["am", "pm"].includes(period)) {
    return null;
  }

  if (period === "am" && hour === 12) {
    hour = 0;
  } else if (period === "pm" && hour !== 12) {
    hour += 12;
  }

  return hour * 60 + minute;
}

// ==================================================
// 6. EXTRACT START AND END TIME
// ==================================================

function extractTimeRange(timeText) {
  if (!timeText) return null;

  const match = timeText.match(
    /(\d{1,2}(?:[:.]\d{1,2})?\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)?)\s*(?:-|–|—|\bto\b)\s*(\d{1,2}(?:[:.]\d{1,2})?\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)?)/i,
  );


  if (!match) return null;

  const startText = match[1].trim();
  const endText = match[2].trim();

  function getPeriod(value) {
    const result = value.match(/([ap])\.?\s*m\.?/i);
    return result ? `${result[1].toLowerCase()}m` : null;
  }

  const startPeriod = getPeriod(startText);
  const endPeriod = getPeriod(endText);


  const startTimeMinutes = parseTime(startText, startPeriod || endPeriod);

  const endTimeMinutes = parseTime(endText, endPeriod || startPeriod);
 

  if (
    startTimeMinutes === null ||
    endTimeMinutes === null ||
    endTimeMinutes <= startTimeMinutes
  ) {
    return null;
  }

  return { startTimeMinutes, endTimeMinutes };
}

// ==================================================
// 7. EXTRACT DAYS
// ==================================================

function extractDays(daysText) {
  if (!daysText) return [];

  const text = daysText.toLowerCase();

  const rangeMatch = text.match(
    /\b(mon|monday|mndy|tue|tues|tuesday|wed|wednesday|thu|thur|thursday|fri|friday|sat|saturday|sun|sunday)\b\s*(?:to|through|until|-|–)\s*\b(mon|monday|mndy|tue|tues|tuesday|wed|wednesday|thu|thur|thursday|fri|friday|sat|saturday|sun|sunday)\b/i,
  );

  if (rangeMatch) {
    const start = WEEKDAYS.indexOf(DAY_ALIASES[rangeMatch[1].toLowerCase()]);

    const end = WEEKDAYS.indexOf(DAY_ALIASES[rangeMatch[2].toLowerCase()]);

    if (start !== -1 && end !== -1 && start <= end) {
      return WEEKDAYS.slice(start, end + 1);
    }
  }

  const tokens = text.match(/[a-z]+/g) || [];

  return [
    ...new Set(tokens.map((token) => DAY_ALIASES[token]).filter(Boolean)),
  ];
}

// ==================================================
// 8. PARSE COMPLETE TUITION REQUIREMENT
// ==================================================

function parseRequirement(text) {
  const fields = extractFields(text);
  const timeRange = extractTimeRange(fields.time);
  const sessionMatch = fields.sessions?.match(/\d+/);
  
  return {
    student: fields.student || null,
    class: fields.class || null,
    course: fields.course || null,
    subject: fields.subject ? fields.subject.trim().toLowerCase() : null,
    sessions: sessionMatch ? Number(sessionMatch[0]) : null,
    days: extractDays(fields.days),
    startTimeMinutes: timeRange?.startTimeMinutes ?? null,
    endTimeMinutes: timeRange?.endTimeMinutes ?? null,
  };
}

//extract remark or comments

function hasExcludedRequirement(text) {
  return /\b100\s*%\s*english\s+communication\b/i.test(normalizeMessage(text));
}

// extrat grade

function extractGrade(classText) {
  if (!classText) return null;

  const match = classText.match(
    /\b(?:class|grade|std\.?|standard)?\s*(\d{1,2})\b/i,
  );

  return match ? Number(match[1]) : null;
}
// ==================================================
// 9. MATCH YOUR PREFERENCES
// ==================================================
function matchesPreferences(requirement, originalText) {
  const preferences = loadPreferences();

  // Rule 1: Reject the excluded communication requirement.
  if (hasExcludedRequirement(originalText)) {
    return {
      matched: false,
      reason: "Requires 100% English Communication",
    };
  }

  // Rule 2: The subject must be configured.
  if (!requirement.subject) {
    return {
      matched: false,
      reason: "Subject missing",
    };
  }

  if (!preferences.subjects.includes(requirement.subject)) {
    return {
      matched: false,
      reason: "Subject mismatch",
    };
  }

  // Rule 3: The full class time must fit inside one configured time window.
  if (requirement.startTimeMinutes === null || requirement.endTimeMinutes === null) {
    return {
      matched: false,
      reason: "Time missing or ambiguous",
    };
  }

  const fitsTimeWindow = preferences.timeWindows.some(
    (window) =>
      requirement.startTimeMinutes >= window.startMinutes &&
      requirement.endTimeMinutes <= window.endMinutes,
  );

  if (!fitsTimeWindow) {
    return {
      matched: false,
      reason: "Class time is outside configured time windows",
    };
  }

  // Rule 4: The class must be on configured available days.
  if (!requirement.days.length) {
    return {
      matched: false,
      reason: "Class days missing or unknown",
    };
  }

  const unavailableDays = requirement.days.filter(
    (day) => !preferences.availableDays.includes(day.toLowerCase()),
  );

  if (unavailableDays.length > 0) {
    return {
      matched: false,
      reason: `Unavailable days: ${unavailableDays.join(", ")}`,
    };
  }

  // Rule 5: The class must meet the configured minimum grade.
  if (!requirement.class) {
    return {
      matched: false,
      reason: "Class missing",
    };
  }

  const normalizedClass = requirement.class.trim().toLowerCase();

  const grade = extractGrade(requirement.class);

  if (grade === null || grade < preferences.minimumClass) {
    return { matched: false, reason: "Class below configured minimum or missing" };
  }

  return {
    matched: true,
    reason: "All preferences matched",
  };
}

// ==================================================
// 10. DEDUPLICATE MESSAGE IDS
// ==================================================

function hasSeenMessage(id) {
  if (!id) return false;
  if (seen.has(id)) return true;

  seen.add(id);

  if (seen.size > MAX_SEEN) {
    seen.delete(seen.values().next().value);
  }

  return false;
}

// ==================================================
// 11. PRESERVE YOUR KEYWORD FILTER
// ==================================================

function passesKeywordFilter(text) {
  if (!cfg.USE_KEYWORD_FILTER) return true;
  if (keywords.length === 0) return true;

  const normalized = text.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword));
}

// ==================================================
// 12. SEND REPLIES
// ==================================================

async function sendReplies(msg, requirement) {
  // Safety: do not send anything during dry-run mode.
  if (cfg.ENABLE_AUTO_REPLY !== true) {
    console.log("[DRY RUN] Matching requirement; no messages sent.");
    return;
  }

  const mode = cfg.REPLY_MODE;
  const jobs = [];

  if (mode === "group" || mode === "both") {
    jobs.push(msg.reply(cfg.GROUP_REPLY));
  }

  if ((mode === "dm" || mode === "both") && msg.author) {
    const senderId = msg.author;
    const messageId = idOf(msg.id);

    jobs.push(
      (async () => {
        try {
          await client.sendMessage(senderId, cfg.DM_REPLY, {
            quotedMessageId: messageId,
          });
        } catch (error) {
          console.warn("Quoted DM failed; trying plain DM.");
          await client.sendMessage(senderId, cfg.DM_REPLY);
        }
      })(),
    );
  }

  if (cfg.NOTIFY_SELF && client.info) {
    const selfId = idOf(client.info.wid);

    if (selfId) {
      const notification = [
        "Matching tuition requirement:",
        `Student: ${requirement.student || "Unknown"}`,
        `Class: ${requirement.class || "Unknown"}`,
        `Subject: ${requirement.subject}`,
        `Sessions: ${requirement.sessions ?? "Unknown"}`,
      ].join("\n");

      jobs.push(client.sendMessage(selfId, notification));
      jobs.push(client.sendMessage("120363415081288381@g.us", notification));
    }
  }

  const results = await Promise.allSettled(jobs);

  results.forEach((result) => {
    if (result.status === "rejected") {
      console.error("Send failed:", result.reason);
    }
  });
}

// ==================================================
// 13. PROCESS EACH INCOMING MESSAGE
// ==================================================

async function processMessage(msg) {
  if (msg.fromMe) return;
  if (!groups.has(msg.from)) return;


  const id = idOf(msg.id);

  if (hasSeenMessage(id)) {
    console.log("Duplicate message ignored:", id);
    return;
  }

  const text = normalizeMessage(msg.body);
 

  if (!text) return;

  if (!passesKeywordFilter(text)) {
    console.log("Skipped: keyword filter");
    pushLog('info', 'Message skipped: keyword filter');
    return;
  }

  const requirement = parseRequirement(text);
 
result = matchesPreferences(requirement, text);

  console.log("\nIncoming tuition broadcast:");
  console.log(JSON.stringify(requirement, null, 2));
  console.log("Decision:", result.reason);
  pushLog(result.matched ? 'success' : 'info', `Decision: ${result.reason}`);

  if (!result.matched) return;

  // msg.author is the group-message sender.
  // msg.from is the group ID, so never use it as the DM recipient.
  if (!msg.author) {
    console.warn("Sender ID unavailable; skipping reply.");
    return;
  }

  await sendReplies(msg, requirement);

  console.log(
    new Date().toLocaleTimeString(),
    "Processed matching message from",
    msg.author,
  );
}

// ==================================================
// 14. REGISTER MESSAGE HANDLER
// ==================================================

client.on("message", async (msg) => {
  try {
    await processMessage(msg);
  } catch (error) {
    console.error("Message processing failed:", error);
  }
});

// Expose client globally so server.js can call destroy/initialize
global.whatsappClient = client;

client.initialize().catch((error) => {
  console.error('WhatsApp client initialization failed:', error);
  setStatus('disconnected');
  pushLog('error', `WhatsApp initialization failed: ${error.message}`);
});
