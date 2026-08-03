import * as core from '@actions/core';
import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const BASE_URL = 'https://wt3.autoroutes-trafic.fr//realtime/trafficevents';
const MAX_LOOKBACK_SECONDS = 180; // Recherche jusqu'à 3 minutes dans le passé
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DB_FILE = path.join(process.cwd(), 'sent_events.json');

// --- DICTIONNAIRE DES TYPES D'ALERTES ---
const EVENT_TYPES = {
  'AC': { label: 'Accident', emoji: '💥' },
  'CO': { label: 'Fermeture / Coupure', emoji: '⛔' },
  'TR': { label: 'Travaux', emoji: '🚧' },
  'IN': { label: 'Incident / Obstacle', emoji: '⚠️' },
  'IF': { label: 'Information / Service', emoji: 'ℹ️' },
  'DEFAULT': { label: 'Restriction de voie', emoji: '🚗' }
};

/**
 * Convertit un timestamp Unix (en secondes) en hexadécimal sur 8 caractères
 */
function toHexTimestamp(epochSeconds) {
  return epochSeconds.toString(16).toUpperCase().padStart(8, '0');
}

/**
 * Charge la liste des IDs déjà envoyés depuis sent_events.json
 */
function loadSentEvents() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(data);
      console.log(`[LOG DB] ${parsed.length} ID(s) enregistrés dans sent_events.json.`);
      return new Set(parsed);
    } catch (e) {
      console.warn('[WARN DB] Fichier sent_events.json corrompu, réinitialisation.');
    }
  } else {
    console.log('[LOG DB] sent_events.json introuvable. Initialisation.');
  }
  return new Set();
}

/**
 * Sauvegarde la liste mise à jour des IDs (conserve les 1000 derniers)
 */
function saveSentEvents(sentSet) {
  const arrayToSave = Array.from(sentSet).slice(-1000);
  fs.writeFileSync(DB_FILE, JSON.stringify(arrayToSave, null, 2));
}

/**
 * Teste une URL donnée et valide la présence STRICTE de "var eventsData = ["
 */
async function testUrl(targetUrl) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const response = await fetch(targetUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) return { success: false };

    const text = await response.text();
    const cleanText = text.trim();
    
    // Détection stricte pour éviter les faux positifs du serveur HTTP
    if (cleanText.includes('var eventsData = [') || cleanText.startsWith('var eventsData=[')) {
      return { success: true, data: text };
    }

    return { success: false };
  } catch (error) {
    return { success: false };
  }
}

/**
 * Convertit le contenu JS "var eventsData = [...]" en objet JSON
 */
function parseEventsData(jsContent) {
  try {
    const match = jsContent.match(/var\s+eventsData\s*=\s*(\[\s*\{.*\}\s*\])\s*;?/s);
    if (match && match[1]) {
      return JSON.parse(match[1]);
    }
    const fallbackMatch = jsContent.match(/\[\s*\{.*\}\s*\]/s);
    if (fallbackMatch) {
      return JSON.parse(fallbackMatch[0]);
    }
    // Si la liste est explicitement vide dans le JS
    if (jsContent.includes('eventsData = []')) {
      return [];
    }
    return [];
  } catch (error) {
    console.error(`[ERREUR PARSE] Échec de la conversion du JSON : ${error.message}`);
    return [];
  }
}

/**
 * Calcule une empreinte/ID unique pour chaque alerte
 */
function getEventId(event) {
  if (event.id) return String(event.id);
  const date = event.date || event.timestamp || '';
  const lat = event.lat || event.latitude || '';
  const lon = event.lon || event.lng || event.longitude || '';
  const type = event.type || event.code || '';
  return `${type}_${lat}_${lon}_${date}`;
}

/**
 * Envoie un embed formaté vers Discord
 */
async function sendDiscordWebhook(event) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn(`[WARN DISCORD] DISCORD_WEBHOOK_URL absent. Envoi ignoré.`);
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
        color: (typeCode === 'CO' || typeCode === 'AC') ? 15158332 : 16753920,
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
      console.log(`[SUCCÈS DISCORD] Notification envoyée pour l'événement ${getEventId(event)}.`);
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
  console.log(`[LOG HEURE] Hex T=0 : ${toHexTimestamp(nowInSeconds)}`);
  console.log('--------------------------------------------------');

  let foundUrl = null;
  let validData = null;
  let validHex = null;
  let offsetFound = 0;

  // 1. RECHERCHE ET BALAYAGE DU BON TIMESTAMP
  for (let offset = 0; offset <= MAX_LOOKBACK_SECONDS; offset++) {
    const currentEpoch = nowInSeconds - offset;
    const hex = toHexTimestamp(currentEpoch);
    const testTargetUrl = `${BASE_URL}/${hex}/events.js`;

    const result = await testUrl(testTargetUrl);

    if (result.success) {
      foundUrl = testTargetUrl;
      validData = result.data;
      validHex = hex;
      offsetFound = offset;
      break;
    }
  }

  if (!foundUrl) {
    console.log(`[ÉCHEC] Aucun fichier valide trouvé sur les ${MAX_LOOKBACK_SECONDS} dernières secondes.`);
    core.setFailed("Impossible de trouver un timestamp valide pour events.js.");
    return;
  }

  console.log(`[SUCCÈS] Lien valide trouvé !`);
  console.log(`[LOG HEX]  Timestamp retenu : ${validHex}`);
  console.log(`[LOG TIME] Décalage        : -${offsetFound} seconde(s)`);
  console.log(`[LOG URL]  Lien fonctionnel : ${foundUrl}`);
  console.log(`[LOG DATA] Aperçu contenu  : ${validData.substring(0, 100)}...`);
  console.log('--------------------------------------------------');

  // 2. PARSING ET DÉDUPLICATION DES ÉVÉNEMENTS
  const events = parseEventsData(validData);
  console.log(`[LOG PARSE] ${events.length} événement(s) trouvé(s) dans le fichier.`);

  if (events.length === 0) {
    console.log('[LOG] Aucun événement actif sur le réseau autoroutier.');
    return;
  }

  const sentEvents = loadSentEvents();
  let newEventsCount = 0;

  // 3. ENVOI DISCORD + MISE À JOUR HISTORIQUE
  for (const event of events) {
    const eventId = getEventId(event);

    if (sentEvents.has(eventId)) {
      console.log(`[IGNORÉ] Déjà envoyé auparavant (ID: ${eventId})`);
      continue;
    }

    console.log(`[NOUVEAU] Traitement de l'événement ID : ${eventId}`);
    await sendDiscordWebhook(event);

    sentEvents.add(eventId);
    newEventsCount++;
  }

  if (newEventsCount > 0) {
    saveSentEvents(sentEvents);
    console.log(`[SUCCÈS BATCH] ${newEventsCount} nouvelle(s) alerte(s) envoyée(s). Fichier sent_events.json mis à jour.`);
  } else {
    console.log(`[INFO] Toutes les alertes du fichier étaient déjà connues.`);
  }
}

run();
