const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require('qrcode');
const cfg = require("./config");
const { pushLog, setStatus, setQr, setInfo } = require('./botState');

// Start the dashboard web server alongside the bot
require('./server');
const { parseVacancyWithAI } = require('./aiParser');

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
  setStatus('ready');
  setInfo(client.info);
  pushLog('success', `Bot ready — watching ${groups.size} group(s)`);
  pushLog('info', `Subject filter: ${preferences.subjects.join(', ')}`);
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
    scheduleSlots: [],
  };
}

function getMissingMatchFields(requirement) {
  const missing = [];
  if (!requirement?.class || extractGrade(requirement.class) === null) missing.push("class");
  if (!requirement?.subject) missing.push("subject");
  if (!Array.isArray(requirement?.days) || requirement.days.length === 0) missing.push("days");
  const hasValidScheduleSlots =
    Array.isArray(requirement?.scheduleSlots) &&
    requirement.scheduleSlots.length > 0 &&
    requirement.scheduleSlots.every((slot) =>
      Number.isInteger(slot.startTimeMinutes) &&
      Number.isInteger(slot.endTimeMinutes) &&
      slot.endTimeMinutes > slot.startTimeMinutes,
    );
  if (!hasValidScheduleSlots && (
    !Number.isInteger(requirement?.startTimeMinutes) ||
    !Number.isInteger(requirement?.endTimeMinutes) ||
    requirement.endTimeMinutes <= requirement.startTimeMinutes
  )) {
    missing.push("time range");
  }
  return missing;
}

function getMissingLabeledOptionalFields(text, requirement) {
  const labeledFields = extractFields(text);
  const missing = [];
  for (const field of ["student", "course", "sessions"]) {
    if (
      Object.prototype.hasOwnProperty.call(labeledFields, field) &&
      (requirement?.[field] === null || requirement?.[field] === undefined || requirement?.[field] === "")
    ) {
      missing.push(field);
    }
  }
  return missing;
}

function countTimeRanges(text) {
  const rangePattern =
    /\d{1,2}(?:[:.]\d{1,2})?\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)?\s*(?:-|\u2013|\u2014|\bto\b)\s*\d{1,2}(?:[:.]\d{1,2})?\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)?/gi;
  return normalizeMessage(text).match(rangePattern)?.length || 0;
}

function findAmbiguousRegexFields(text) {
  const aliases = {
    student: "student", name: "student", class: "class", grade: "class",
    course: "course", subject: "subject", session: "sessions", sessions: "sessions",
    time: "time", timing: "time", day: "days", days: "days",
  };
  const labelPattern = /^\s*(STUDENT|NAME|CLASS|GRADE|COURSE|SUBJECT|SESSIONS?|TIME|TIMING|DAYS?)\s*[:\uFF1A-]\s*(.*?)\s*$/i;
  const valuesByField = new Map();

  for (const line of normalizeMessage(text).split("\n")) {
    const match = line.match(labelPattern);
    if (!match) continue;
    const field = aliases[match[1].toLowerCase()];
    const values = valuesByField.get(field) || new Set();
    values.add(match[2].trim().toLowerCase().replace(/\s+/g, " "));
    valuesByField.set(field, values);
  }

  const ambiguous = [...valuesByField.entries()]
    .filter(([, values]) => values.size > 1)
    .map(([field]) => field);
  return ambiguous;
}

function parsedValuesMatch(field, regexValue, aiValue) {
  if (field === "class") {
    const regexGrade = extractGrade(regexValue);
    const aiGrade = extractGrade(aiValue);
    if (regexGrade !== null && aiGrade !== null) return regexGrade === aiGrade;
  }
  if (field === "days") {
    const normalizeDays = (days) => [...days].map((day) => day.toLowerCase()).sort();
    return JSON.stringify(normalizeDays(regexValue)) === JSON.stringify(normalizeDays(aiValue));
  }
  if (field === "subject") {
    return String(regexValue).trim().toLowerCase() === String(aiValue).trim().toLowerCase();
  }
  return String(regexValue).trim().toLowerCase() === String(aiValue).trim().toLowerCase();
}

function mergeRegexAndAI(regexRequirement, aiRequirement) {
  const merged = { ...regexRequirement };
  const conflicts = [];
  const criticalFields = new Set(["class", "subject"]);

  for (const field of ["student", "class", "course", "subject", "sessions"]) {
    const regexValue = regexRequirement[field];
    const aiValue = aiRequirement[field];
    const regexClassIsUnusable = field === "class" && extractGrade(regexValue) === null;

    if (regexValue === null || regexValue === undefined || regexValue === "" || regexClassIsUnusable) {
      merged[field] = aiValue;
    } else if (aiValue !== null && aiValue !== undefined && !parsedValuesMatch(field, regexValue, aiValue)) {
      if (criticalFields.has(field)) conflicts.push(field);
    }
  }

  const regexHasTime =
    Number.isInteger(regexRequirement.startTimeMinutes) &&
    Number.isInteger(regexRequirement.endTimeMinutes) &&
    regexRequirement.endTimeMinutes > regexRequirement.startTimeMinutes;

  const aiScheduleSlots = Array.isArray(aiRequirement.scheduleSlots)
    ? aiRequirement.scheduleSlots
    : [];

  if (aiScheduleSlots.length) {
    const regexDays = Array.isArray(regexRequirement.days) ? regexRequirement.days : [];
    if (regexDays.some((day) => !aiRequirement.days.includes(day))) {
      conflicts.push("days");
    }
    merged.days = aiRequirement.days;

    const regexTimeMatchesAI = !regexHasTime || (regexDays.length
      ? regexDays.every((day) =>
          aiScheduleSlots.some((slot) =>
            slot.day === day &&
            slot.startTimeMinutes === regexRequirement.startTimeMinutes &&
            slot.endTimeMinutes === regexRequirement.endTimeMinutes,
          ),
        )
      : aiScheduleSlots.some((slot) =>
          slot.startTimeMinutes === regexRequirement.startTimeMinutes &&
          slot.endTimeMinutes === regexRequirement.endTimeMinutes,
        ));
    if (!regexTimeMatchesAI) {
      conflicts.push("time range");
    }

    merged.scheduleSlots = aiScheduleSlots;
    merged.startTimeMinutes = aiScheduleSlots.length === 1
      ? aiScheduleSlots[0].startTimeMinutes
      : null;
    merged.endTimeMinutes = aiScheduleSlots.length === 1
      ? aiScheduleSlots[0].endTimeMinutes
      : null;
  } else {
    if (!Array.isArray(regexRequirement.days) || regexRequirement.days.length === 0) {
      merged.days = aiRequirement.days;
    } else if (!parsedValuesMatch("days", regexRequirement.days, aiRequirement.days)) {
      conflicts.push("days");
    }

    merged.scheduleSlots = [];
    if (!regexHasTime) {
      merged.startTimeMinutes = aiRequirement.startTimeMinutes;
      merged.endTimeMinutes = aiRequirement.endTimeMinutes;
    } else if (
      regexRequirement.startTimeMinutes !== aiRequirement.startTimeMinutes ||
      regexRequirement.endTimeMinutes !== aiRequirement.endTimeMinutes
    ) {
      conflicts.push("time range");
    }
  }

  return { requirement: merged, conflicts: [...new Set(conflicts)] };
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
function matchesPreferences(
  requirement,
  originalText,
  parseBlockReason = null,
  preferenceSnapshot = null,
) {
  const preferences = preferenceSnapshot || loadPreferences();

  // Rule 1: Reject the excluded communication requirement.
  if (hasExcludedRequirement(originalText)) {
    return {
      matched: false,
      reason: "Requires 100% English Communication",
    };
  }

  if (parseBlockReason) {
    return { matched: false, reason: parseBlockReason };
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

  // Rule 3: Every required class slot must fit inside a configured time window.
  const scheduleSlots = Array.isArray(requirement.scheduleSlots)
    ? requirement.scheduleSlots
    : [];
  if (scheduleSlots.length) {
    const outsideWindow = scheduleSlots.find((slot) =>
      !preferences.timeWindows.some(
        (window) =>
          slot.startTimeMinutes >= window.startMinutes &&
          slot.endTimeMinutes <= window.endMinutes,
      ),
    );
    if (outsideWindow) {
      return {
        matched: false,
        reason: `Class time on ${outsideWindow.day} is outside configured time windows`,
      };
    }
  } else {
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

let missingAiKeyWarningLogged = false;

async function processMessage(msg) {
  if (msg.fromMe) return;
  if (!groups.has(msg.from)) return;


  const id = idOf(msg.id);

  if (hasSeenMessage(id)) {
    return;
  }

  const text = normalizeMessage(msg.body);
  if (!text) return;

  if (!passesKeywordFilter(text)) {
    pushLog('info', 'Message skipped: keyword filter');
    return;
  }

  // Use one preference snapshot for the AI assessment and the local safety check.
  const preferenceSnapshot = loadPreferences();

  let requirement;
  try {
    requirement = parseRequirement(text);
  } catch (error) {
    console.warn("Regex parser failed:", error.message);
    pushLog('error', 'Regex parser failed; trying AI fallback.');
    requirement = {
      student: null,
      class: null,
      course: null,
      subject: null,
      sessions: null,
      days: [],
      startTimeMinutes: null,
      endTimeMinutes: null,
      scheduleSlots: [],
    };
  }

  const missingFields = [
    ...new Set([
      ...getMissingMatchFields(requirement),
      ...getMissingLabeledOptionalFields(text, requirement),
    ]),
  ];
  const ambiguousFields = findAmbiguousRegexFields(text);
  const timeRangeCount = countTimeRanges(text);
  const hasMultipleScheduleRanges = timeRangeCount > 1;
  let parseBlockReason = null;

  if (missingFields.length || ambiguousFields.length || hasMultipleScheduleRanges) {
    const fallbackReasons = [
      ...missingFields,
      ...ambiguousFields.map((field) => `ambiguous ${field}`),
      ...(hasMultipleScheduleRanges ? ["multiple schedule slots"] : []),
    ];
    pushLog(
      'info',
      `Regex extraction needs fallback (${fallbackReasons.join(', ') || 'parser error'}).`,
    );

    const aiResult = await parseVacancyWithAI(text, preferenceSnapshot);
    if (aiResult.ok) {
      const merged = mergeRegexAndAI(requirement, aiResult.data);
      const unresolvedAmbiguities = ambiguousFields.filter(
        (field) => !(field === "time" && aiResult.data.scheduleSlots?.length > 1),
      );
      if (
        hasMultipleScheduleRanges &&
        aiResult.data.scheduleSlots.length < timeRangeCount
      ) {
        parseBlockReason = "AI did not extract every schedule slot";
        console.warn(parseBlockReason);
        pushLog('error', `${parseBlockReason}; message will not be auto-replied.`);
      } else if (unresolvedAmbiguities.length) {
        parseBlockReason = `Ambiguous message fields: ${unresolvedAmbiguities.join(', ')}`;
      } else if (merged.conflicts.length) {
        parseBlockReason = `Regex and AI disagree on: ${merged.conflicts.join(', ')}`;
      } else {
        requirement = merged.requirement;
        const stillMissing = getMissingMatchFields(requirement);
        if (stillMissing.length) {
          parseBlockReason = `Required fields remain unclear: ${stillMissing.join(', ')}`;
        } else if (!aiResult.data.matchesPreferences) {
          parseBlockReason = `AI judged vacancy outside configured preferences: ${aiResult.data.matchReason}`;
        } else {
          pushLog('info', `AI assessment matched configured preferences: ${aiResult.data.matchReason}; applying local checks.`);
        }
      }
    } else if (ambiguousFields.length) {
      parseBlockReason = `Ambiguous message fields: ${ambiguousFields.join(', ')}`;
      console.warn(`AI fallback could not safely resolve ambiguous fields: ${aiResult.reason}`);
      pushLog('error', `AI fallback did not resolve ambiguity: ${aiResult.reason}`);
    } else if (hasMultipleScheduleRanges) {
      parseBlockReason = `Could not safely parse multiple schedule slots: ${aiResult.reason}`;
      console.warn(parseBlockReason);
      pushLog('error', `${parseBlockReason}; message will not be auto-replied.`);
    } else if (/ambiguous/i.test(aiResult.reason || "")) {
      parseBlockReason = 'AI fallback could not confidently resolve required information';
      console.warn(`AI fallback found ambiguous required information: ${aiResult.reason}`);
      pushLog('error', `AI fallback found ambiguous required information: ${aiResult.reason}; message will not be auto-replied.`);
    } else if (aiResult.skipped && aiResult.reason === "GROQ_API_KEY is not configured") {
      if (!missingAiKeyWarningLogged) {
        console.warn("AI fallback is disabled; set GROQ_API_KEY to enable it.");
        pushLog('info', 'AI fallback disabled: GROQ_API_KEY is not configured.');
        missingAiKeyWarningLogged = true;
      }
    } else {
      console.warn(`AI fallback unavailable: ${aiResult.reason}`);
      pushLog('error', `AI fallback unavailable: ${aiResult.reason}`);
    }
  }

  const result = matchesPreferences(requirement, text, parseBlockReason, preferenceSnapshot);

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
    "Processed matching vacancy.",
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
