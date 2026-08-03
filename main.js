import * as core from '@actions/core';
import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const BASE_URL = 'https://wt3.autoroutes-trafic.fr//realtime/trafficevents';
const MAX_LOOKBACK_SECONDS = 180;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DB_FILE = path.join(process.cwd(), 'sent_events.json');

// --- MOTS CLÉS & CONFIGURATION COULEURS ---
const RED_KEYWORDS = ['toutes les voies', 'totale', 'totales'];
const BLACKLIST_WORDS = ['mot-interdit', 'faux-accident'];

const COLORS = {
  RED: 15158332,
  YELLOW: 16776960,
  BLUE: 3447003,
  GREY: 12370112,
  BLACK: 1
};

const EVENT_TYPES = {
  'AC': { label: 'Accident', emoji: '💥' },
  'CO': { label: 'Fermeture / Coupure', emoji: '⛔' },
  'TR': { label: 'Travaux', emoji: '🚧' },
  'IN': { label: 'Incident / Obstacle', emoji: '⚠️' },
  'IF': { label: 'Information / Service', emoji: 'ℹ️' },
  'DEFAULT': { label: 'Restriction de voie', emoji: '🚗' }
};

function toHexTimestamp(epochSeconds) {
  return epochSeconds.toString(16).toUpperCase().padStart(8, '0');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadSentEvents() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return new Set(JSON.parse(data));
    } catch (e) {
      console.warn('[WARN DB] Fichier sent_events.json corrompu, réinitialisation.');
    }
  }
  return new Set();
}

function saveSentEvents(sentSet) {
  const arrayToSave = Array.from(sentSet).slice(-1000);
  fs.writeFileSync(DB_FILE, JSON.stringify(arrayToSave, null, 2));
}

async function testUrl(targetUrl) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(targetUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) return { success: false };
    const text = await response.text();
    const cleanText = text.trim();
    
    if (cleanText.includes('var eventsData = [') || cleanText.startsWith('var eventsData=[')) {
      return { success: true, data: text };
    }
    return { success: false };
  } catch (error) {
    return { success: false };
  }
}

function parseEventsData(jsContent) {
  try {
    if (jsContent.replace(/\s/g, '').includes('eventsData=[]')) return [];

    const varStartIndex = jsContent.indexOf('var eventsData');
    if (varStartIndex === -1) return [];

    const arrayStartIndex = jsContent.indexOf('[', varStartIndex);
    if (arrayStartIndex === -1) return [];

    let bracketCount = 0;
    let inString = false;
    let isEscaped = false;
    let arrayEndIndex = -1;

    for (let i = arrayStartIndex; i < jsContent.length; i++) {
      const char = jsContent[i];
      if (isEscaped) { isEscaped = false; continue; }
      if (char === '\\') { isEscaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }

      if (!inString) {
        if (char === '[') bracketCount++;
        if (char === ']') {
          bracketCount--;
          if (bracketCount === 0) {
            arrayEndIndex = i;
            break;
          }
        }
      }
    }

    if (arrayEndIndex !== -1) {
      const pureJsonString = jsContent.substring(arrayStartIndex, arrayEndIndex + 1);
      return JSON.parse(pureJsonString);
    }
    return [];
  } catch (error) {
    console.error(`[ERREUR PARSE] Échec de la conversion du JSON : ${error.message}`);
    return [];
  }
}

function extractEventData(event) {
  if (!Array.isArray(event) || event.length < 4) {
    return { type: '', date: '', message: '', lat: '0', lon: '0' };
  }

  const type = event[1] || '';
  const date = event[2] || '';
  const message = (event[3] && event[3].FR) ? event[3].FR : "Aucun détail fourni";
  
  let lat = '0';
  let lon = '0';
  try {
    const zoomLevels = Object.values(event[0]);
    if (zoomLevels.length > 0) {
      const coords = zoomLevels[0][0]; 
      lat = coords[0];
      lon = coords[1];
    }
  } catch (e) {}

  return { type, date, message, lat, lon };
}

function getEventId(event) {
  const data = extractEventData(event);
  if (!data.type && !data.date) return '___';
  return `${data.type}_${data.lat}_${data.lon}_${data.date}`;
}

function analyzeAlert(typeCode, originalMessage) {
  let color = COLORS.BLUE; 
  let message = originalMessage;
  const msgLower = originalMessage.toLowerCase();

  const isBlacklisted = BLACKLIST_WORDS.some(word => msgLower.includes(word));
  if (isBlacklisted) {
    const truncatedMsg = message.substring(0, 30) + '... [ALERTE TRONQUÉE / SÉCURITÉ]';
    return { color: COLORS.BLACK, message: truncatedMsg };
  }

  const isRed = RED_KEYWORDS.some(word => msgLower.includes(word)) || typeCode === 'CO' || typeCode === 'AC';
  const isYellow = typeCode === 'TR' || msgLower.includes('travaux');
  const isGrey = typeCode === 'IF' || msgLower.includes('information');

  if (isRed) {
    color = COLORS.RED;
  } else if (isYellow) {
    color = COLORS.YELLOW;
  } else if (isGrey) {
    color = COLORS.GREY;
  }

  return { color, message };
}

async function sendDiscordWebhook(event) {
  if (!DISCORD_WEBHOOK_URL) return false;

  const data = extractEventData(event);
  const typeCode = data.type.toUpperCase();
  const eventInfo = EVENT_TYPES[typeCode] || EVENT_TYPES['DEFAULT'];

  const { color, message: finalMessage } = analyzeAlert(typeCode, data.message);
  const wmeUrl = `https://www.waze.com/fr/editor?env=row&lat=${data.lat}&lon=${data.lon}&zoomLevel=18`;

  // Formatage de la date brute sans décalage horaire (ex: "2026-08-03T05:31:30" -> "03/08/2026 05:31:30")
  let formattedDate = data.date;
  try {
    if (data.date && data.date.includes('T')) {
      const [datePart, timePart] = data.date.split('T');
      const [year, month, day] = datePart.split('-');
      formattedDate = `${day}/${month}/${year} ${timePart}`;
    }
  } catch (e) {}

  const embedPayload = {
    username: "Notification Carte 107.7",
    avatar_url: "https://play-lh.googleusercontent.com/blGO7H3iQBS5_vQ3L4rjHqGqHU_jyFbgl-jDNi7DTpmme-aSjxZP5_aC89SYie2fvxUuQR2MgyolLfxMpRlmyg",
    embeds: [
      {
        title: `${eventInfo.emoji} ${eventInfo.label}`,
        url: "https://www.vinci-autoroutes.com/fr/autoroutes-temps-reel/",
        color: color,
        // Ajout du préfixe "> " pour indenter (décaler) le texte sur la droite
        description: [
          `> 🕒 **Date** : ${formattedDate}`,
          `> 📢 **Message** : ${finalMessage}`,
          `> 📍 **Coordonnées** : ${data.lat}, ${data.lon} ([Ouvrir dans WME](${wmeUrl}))`
        ].join('\n'),
        footer: { text: "Radio 107.7 - Trafic Temps Réel" }
      }
    ]
  };

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(embedPayload)
    });

    if (res.ok) {
      console.log(`[SUCCÈS DISCORD] Notification envoyée (Type: ${typeCode}, Couleur: ${color}).`);
      return true;
    } else if (res.status === 429) {
      console.warn(`[RATE LIMIT] Discord 429 détecté. Nouvelle tentative après pause...`);
      await sleep(2000); 
      return await sendDiscordWebhook(event); 
    } else {
      console.error(`[ERREUR DISCORD] Statut HTTP ${res.status}`);
      return false;
    }
  } catch (err) {
    console.error(`[ERREUR DISCORD] ${err.message}`);
    return false;
  }
}

async function run() {
  const now = new Date();
  const nowInSeconds = Math.floor(now.getTime() / 1000);

  let foundUrl = null;
  let validData = null;

  for (let offset = 0; offset <= MAX_LOOKBACK_SECONDS; offset++) {
    const hex = toHexTimestamp(nowInSeconds - offset);
    const testTargetUrl = `${BASE_URL}/${hex}/events.js`;
    const result = await testUrl(testTargetUrl);

    if (result.success) {
      foundUrl = testTargetUrl;
      validData = result.data;
      break;
    }
  }

  if (!foundUrl) {
    core.setFailed("Impossible de trouver un timestamp valide.");
    return;
  }

  const events = parseEventsData(validData);
  console.log(`[LOG PARSE] ${events.length} événement(s) trouvé(s).`);

  if (events.length === 0) return;

  const sentEvents = loadSentEvents();
  let newEventsCount = 0;

  for (const event of events) {
    const eventId = getEventId(event);
    
    if (eventId === '___') continue;
    if (sentEvents.has(eventId)) continue;

    const success = await sendDiscordWebhook(event);
    if (success) {
      sentEvents.add(eventId);
      newEventsCount++;
      await sleep(350); 
    }
  }

  if (newEventsCount > 0) {
    saveSentEvents(sentEvents);
    console.log(`[SUCCÈS] ${newEventsCount} nouvelle(s) alerte(s) envoyée(s).`);
  } else {
    console.log(`[INFO] Aucune nouvelle alerte. Le fichier est à jour.`);
  }
}

run();
