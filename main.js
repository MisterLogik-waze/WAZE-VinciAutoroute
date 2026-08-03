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

function loadSentEvents() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(data);
      console.log(`[LOG DB] ${parsed.length} ID(s) d'alertes actuellement en mémoire dans sent_events.json.`);
      return new Set(parsed);
    } catch (e) {
      console.warn('[WARN DB] Fichier sent_events.json illisible, création d\'une nouvelle liste.');
    }
  } else {
    console.log('[LOG DB] Aucun fichier sent_events.json trouvé. Initialisation.');
  }
  return new Set();
}

function saveSentEvents(sentSet) {
  const arrayToSave = Array.from(sentSet).slice(-1000);
  fs.writeFileSync(DB_FILE, JSON.stringify(arrayToSave, null, 2));
}

function parseEventsData(jsContent) {
  try {
    // Tentative 1 : Regex classique sur "var eventsData = [...]"
    const match = jsContent.match(/var\s+eventsData\s*=\s*(\[\s*\{.*\}\s*\])\s*;?/s);
    if (match && match[1]) {
      return JSON.parse(match[1]);
    }
    // Tentative 2 : Extraction brute du premier tableau JSON "[...]"
    const fallbackMatch = jsContent.match(/\[\s*\{.*\}\s*\]/s);
    if (fallbackMatch) {
      return JSON.parse(fallbackMatch[0]);
    }
    // Si le tableau est vide (ex: "var eventsData = [];")
    if (jsContent.includes('eventsData')) {
      return [];
    }
    console.warn('[WARN PARSE] Impossible de trouver une structure de tableau dans le JS.');
    return [];
  } catch (error) {
    console.error(`[ERREUR PARSE] Échec de la conversion JSON : ${error.message}`);
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
  if (!DISCORD_WEBHOOK_URL) {
    console.warn(`[WARN DISCORD] URL Webhook non renseignée ! Secret DISCORD_WEBHOOK_URL absent ?`);
    return;
  }

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

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(embedPayload)
    });

    if (!res.ok) {
      console.error(`[ERREUR DISCORD] Statut HTTP ${res.status}`);
    } else {
      console.log(`[SUCCÈS DISCORD] Notification envoyée avec succès pour l'événement ${getEventId(event)}.`);
    }
  } catch (err) {
    console.error(`[ERREUR DISCORD] Échec de la requête : ${err.message}`);
  }
}

async function run() {
  const now = new Date();
  const nowInSeconds = Math.floor(now.getTime() / 1000);

  const timeUTC = now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  const timeParis = now.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

  console.log('--------------------------------------------------');
  console.log(`[LOG HEURE] UTC   : ${timeUTC}`);
  console.log(`[LOG HEURE] Paris : ${timeParis}`);
  console.log(`[LOG HEURE] Hex initial (T=0) : ${toHexTimestamp(nowInSeconds)}`);
  console.log('--------------------------------------------------');

  let validUrl = null;
  let validData = null;
  let validHex = null;

  for (let offset = 0; offset <= MAX_LOOKBACK_SECONDS; offset++) {
    const currentEpoch = nowInSeconds - offset;
    const hex = toHexTimestamp(currentEpoch);
    const url = `${BASE_URL}/${hex}/events.js`;

    try {
      const res = await fetch(url);
      if (res.ok) {
        const text = await res.text();
        // On vérifie que la réponse contient "eventsData" ou un tableau JS
        if (text.includes('eventsData') || text.includes('[')) {
          validUrl = url;
          validData = text;
          validHex = hex;
          console.log(`[SUCCÈS FETCH] Fichier trouvé après -${offset}s de décalage !`);
          break;
        }
      }
    } catch (e) {
      // Poursuite de la recherche
    }
  }

  if (!validUrl) {
    console.error(`[ÉCHEC FETCH] Aucun fichier valide trouvé sur les ${MAX_LOOKBACK_SECONDS} dernières secondes.`);
    core.setFailed("Impossible de trouver un timestamp valide sur autoroutes-trafic.fr.");
    return;
  }

  console.log(`[LOG URL]  URL validée         : ${validUrl}`);
  console.log(`[LOG HEX]  Timestamp retenu    : ${validHex}`);
  console.log(`[LOG DATA] Taille du fichier   : ${validData.length} octets`);
  console.log(`[LOG DATA] Aperçu du contenu  : ${validData.substring(0, 150)}...`);
  console.log('--------------------------------------------------');

  const events = parseEventsData(validData);
  console.log(`[LOG PARSE] ${events.length} événement(s) extrait(s) du fichier.`);

  if (events.length === 0) {
    console.log('[LOG PARSE] Aucun événement actif sur le réseau autoroutier pour le moment.');
    return;
  }

  const sentEvents = loadSentEvents();
  let newEventsCount = 0;

  for (const event of events) {
    const eventId = getEventId(event);

    if (sentEvents.has(eventId)) {
      console.log(`[IGNORÉ] Alerte déjà envoyée précédemment (ID: ${eventId})`);
      continue;
    }

    console.log(`[NÉCESSITE ENVOI] Nouvelle alerte trouvée ! (ID: ${eventId})`);
    await sendDiscordWebhook(event);

    sentEvents.add(eventId);
    newEventsCount++;
  }

  if (newEventsCount > 0) {
    saveSentEvents(sentEvents);
    console.log(`[SUCCÈS TOTAL] ${newEventsCount} nouvelle(s) alerte(s) envoyée(s). Fichier sent_events.json mis à jour.`);
  } else {
    console.log(`[INFO] Toutes les alertes du fichier avaient déjà été notifiées.`);
  }
}

run();
