import * as core from '@actions/core';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'https://wt3.autoroutes-trafic.fr//realtime/trafficevents';
const MAX_LOOKBACK_SECONDS = 90;
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

/**
 * Charge la liste des IDs déjà envoyés
 */
function loadSentEvents() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return new Set(JSON.parse(data));
    } catch (e) {
      console.warn('[WARN] Impossible de lire sent_events.json, réinitialisation.');
    }
  }
  return new Set();
}

/**
 * Sauvegarde la liste mise à jour des IDs
 */
function saveSentEvents(sentSet) {
  // On ne garde que les 1000 derniers IDs pour éviter que le fichier ne devienne trop lourd
  const arrayToSave = Array.from(sentSet).slice(-1000);
  fs.writeFileSync(DB_FILE, JSON.stringify(arrayToSave, null, 2));
}

function parseEventsData(jsContent) {
  try {
    const match = jsContent.match(/var\s+eventsData\s*=\s*(\[\s*\{.*\}\s*\])\s*;?/s);
    if (!match || !match[1]) {
      const fallbackMatch = jsContent.match(/\[\s*\{.*\}\s*\]/s);
      if (!fallbackMatch) return [];
      return JSON.parse(fallbackMatch[0]);
    }
    return JSON.parse(match[1]);
  } catch (error) {
    console.error(`[ERREUR] Parsing JSON : ${error.message}`);
    return [];
  }
}

/**
 * Génère une empreinte unique si l'événement n'a pas d'ID explicite
 */
function getEventId(event) {
  if (event.id) return String(event.id);
  // Secours : clé basée sur le type, les coordonnées et la date/message
  const date = event.date || event.timestamp || '';
  const lat = event.lat || event.latitude || '';
  const lon = event.lon || event.lng || event.longitude || '';
  return `${event.type || ''}_${lat}_${lon}_${date}`;
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
        color: typeCode === 'CO' || typeCode === 'AC' ? 15158332 : 16753920,
        description: [
          `🕒 **Date** : ${event.date || event.timestamp || 'N/C'}`,
          `📢 **Message** : ${event.message || event.description || 'Aucun détail fourni'}`,
          `📍 **Coordonnées** : Lat ${lat}, Lon ${lon} ([Ouvrir dans WME](${wmeUrl}))`
        ].join('\n'),
        footer: {
          text: "Radio 107.7 - Trafic Temps Réel"
        }
      }
    ]
  };

  await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(embedPayload)
  });
}

async function run() {
  const nowInSeconds = Math.floor(Date.now() / 1000);
  let validData = null;

  for (let offset = 0; offset <= MAX_LOOKBACK_SECONDS; offset++) {
    const hex = toHexTimestamp(nowInSeconds - offset);
    const url = `${BASE_URL}/${hex}/events.js`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const text = await res.text();
        if (text.includes('var eventsData =')) {
          validData = text;
          break;
        }
      }
    } catch (e) {}
  }

  if (!validData) {
    core.setFailed("Fichier events.js introuvable.");
    return;
  }

  const events = parseEventsData(validData);
  const sentEvents = loadSentEvents();
  let newEventsCount = 0;

  console.log(`[INFO] ${events.length} événement(s) au total dans le fichier.`);

  for (const event of events) {
    const eventId = getEventId(event);

    // Déduplication : Si l'ID a déjà été traité, on passe
    if (sentEvents.has(eventId)) {
      continue;
    }

    console.log(`[NOUVEAU] Envoi de l'alerte ID : ${eventId}`);
    await sendDiscordWebhook(event);
    
    // Ajout au Registre
    sentEvents.add(eventId);
    newEventsCount++;
  }

  if (newEventsCount > 0) {
    saveSentEvents(sentEvents);
    console.log(`[SUCCÈS] ${newEventsCount} nouvelle(s) alerte(s) envoyée(s). Fichier sent_events.json mis à jour.`);
  } else {
    console.log(`[INFO] Aucune nouvelle alerte à notifier.`);
  }
}

run();
