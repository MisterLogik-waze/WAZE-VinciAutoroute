import * as core from '@actions/core';

// Configuration
const BASE_URL = 'https://wt3.autoroutes-trafic.fr//realtime/trafficevents';
const MAX_LOOKBACK_SECONDS = 90;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Dictionnaire des types d'alertes avec emojis
const EVENT_TYPES = {
  'AC': { label: 'Accident', emoji: '💥' },
  'CO': { label: 'Fermeture / Coupure', emoji: '⛔' },
  'TR': { label: 'Travaux', emoji: '🚧' },
  'IN': { label: 'Incident / Obstacle', emoji: '⚠️' },
  'IF': { label: 'Information / Service', emoji: 'ℹ️' },
  'DEFAULT': { label: 'Restriction de voie', emoji: '🚗' }
};

/**
 * Convertit un timestamp Unix en hexadécimal
 */
function toHexTimestamp(epochSeconds) {
  return epochSeconds.toString(16).toUpperCase().padStart(8, '0');
}

/**
 * Extrait le tableau JS `var eventsData = [...]` sous forme d'objet JSON manipulable
 */
function parseEventsData(jsContent) {
  try {
    // Extraction de ce qui se trouve entre le premier '[' et le dernier ']'
    const match = jsContent.match(/var\s+eventsData\s*=\s*(\[\s*\{.*\}\s*\])\s*;?/s);
    if (!match || !match[1]) {
      // Tendance de secours si la syntaxe varie légèrement
      const fallbackMatch = jsContent.match(/\[\s*\{.*\}\s*\]/s);
      if (!fallbackMatch) return [];
      return JSON.parse(fallbackMatch[0]);
    }
    return JSON.parse(match[1]);
  } catch (error) {
    console.error(`[ERREUR] Échec du parsing JSON : ${error.message}`);
    return [];
  }
}

/**
 * Formate et envoie un Embed vers le Webhook Discord
 */
async function sendDiscordWebhook(event) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn(`[WARN] Pas de DISCORD_WEBHOOK_URL configuré. Envoi ignoré.`);
    return;
  }

  // Détermination du type d'alerte et de l'emoji
  const typeCode = (event.type || event.code || '').toUpperCase();
  const eventInfo = EVENT_TYPES[typeCode] || EVENT_TYPES['DEFAULT'];

  const lat = event.lat || event.latitude || '0';
  const lon = event.lon || event.lng || event.longitude || '0';
  
  // Construction du lien WME (Waze Map Editor)
  const wmeUrl = `https://www.waze.com/fr/editor?env=row&lat=${lat}&lon=${lon}&zoomLevel=18`;

  const embedPayload = {
    username: "Notification Carte 107.7",
    avatar_url: "https://www.vinci-autoroutes.com/favicon.ico",
    embeds: [
      {
        title: `${eventInfo.emoji} ${eventInfo.label}`,
        url: "https://www.vinci-autoroutes.com/fr/autoroutes-temps-reel/",
        color: typeCode === 'CO' || typeCode === 'AC' ? 15158332 : 16753920, // Rouge si Coupure/Accident, Orange sinon
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
      console.error(`[ERREUR Discord] Statut ${res.status} lors de l'envoi.`);
    } else {
      console.log(`[SUCCÈS Discord] Alerte envoyée : ${eventInfo.label}`);
    }
  } catch (err) {
    console.error(`[ERREUR Discord] ${err.message}`);
  }
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
    } catch (e) {
      // Ignorer les erreurs réseau temporaires pendant la recherche
    }
  }

  if (!validData) {
    core.setFailed("Impossible de récupérer un fichier events.js valide.");
    return;
  }

  // Parsing des événements
  const events = parseEventsData(validData);
  console.log(`[INFO] ${events.length} événement(s) trouvé(s) dans le fichier.`);

  // Traitement et envoi de chaque alerte sur Discord
  for (const event of events) {
    await sendDiscordWebhook(event);
  }
}

run();
