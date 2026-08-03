import * as core from '@actions/core';
import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const BASE_URL = 'https://wt3.autoroutes-trafic.fr//realtime/trafficevents';
const MAX_LOOKBACK_SECONDS = 180;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DB_FILE = path.join(process.cwd(), 'sent_events.json');

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

function getEventId(event) {
  if (event.id) return String(event.id);
  const date = event.date || event.timestamp || '';
  const lat = event.lat || event.latitude || '';
  const lon = event.lon || event.lng || event.longitude || '';
  const type = event.type || event.code || '';
  return `${type}_${lat}_${lon}_${date}`;
}

async function sendDiscordWebhook(event) {
  if (!DISCORD_WEBHOOK_URL) return;

  const typeCode = (event.type || event.code || '').toUpperCase();
  const eventInfo = EVENT_TYPES[typeCode] || EVENT_TYPES['DEFAULT'];

  const lat = event.lat || event.latitude || '0';
  const lon = event.lon || event.lng || event.longitude || '0';
  const wmeUrl = `https://www.waze.com/fr/editor?env=row&lat=${lat}&lon=${lon}&zoomLevel=18`;

  const embedPayload = {
    username: "Notification Carte 107.7",
    avatar_url: "https://www.vinci-autoroutes.com/favicon.ico",
    embeds: [
      {
        title: `${eventInfo.emoji} ${eventInfo.label}`,
        url: "https://www.vinci-autoroutes.com/fr/autoroutes-temps-reel/",
        color: (typeCode === 'CO' || typeCode === 'AC') ? 15158332 : 16753920,
        description: [
          `🕒 **Date** : ${event.date || event.timestamp || 'N/C'}`,
          `📢 **Message** : ${event.message || event.description || 'Aucun détail fourni'}`,
          `📍 **Coordonnées** : Lat ${lat}, Lon ${lon} ([Ouvrir dans WME](${wmeUrl}))`
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
      console.log(`[SUCCÈS DISCORD] Notification envoyée pour l'événement ${getEventId(event)}.`);
    }
  } catch (err) {
    console.error(`[ERREUR DISCORD] ${err.message}`);
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

  // --- INSPECTION DES DONNÉES ---
  console.log('--------------------------------------------------');
  console.log('--- STRUCTURE BRUTE D\'UN ÉVÉNEMENT ---');
  console.log(JSON.stringify(events[0], null, 2));
  console.log('--------------------------------------------------');

  const testId = getEventId(events[0]);
  if (testId === '___') {
    core.setFailed("Structure des données inconnue. Exécution arrêtée par sécurité.");
    return;
  }

  const sentEvents = loadSentEvents();
  let newEventsCount = 0;

  for (const event of events) {
    const eventId = getEventId(event);
    if (sentEvents.has(eventId)) continue;

    await sendDiscordWebhook(event);
    sentEvents.add(eventId);
    newEventsCount++;
  }

  if (newEventsCount > 0) saveSentEvents(sentEvents);
}

run();
