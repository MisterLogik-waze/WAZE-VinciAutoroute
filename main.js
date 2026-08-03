import * as core from '@actions/core';

// Configuration
const BASE_URL = 'https://wt3.autoroutes-trafic.fr//realtime/trafficevents';
const MAX_LOOKBACK_SECONDS = 90; // Recherche jusqu'à 90 secondes dans le passé

/**
 * Convertit un timestamp Unix (en secondes) en hexadécimal sur 8 caractères
 */
function toHexTimestamp(epochSeconds) {
  return epochSeconds.toString(16).toUpperCase().padStart(8, '0');
}

/**
 * Teste une URL donnée et valide le contenu JS
 */
async function testUrl(targetUrl) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // Timeout de 3s par requête

    const response = await fetch(targetUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) return { success: false };

    const text = await response.text();
    
    // Validation du contenu : doit commencer par 'var eventsData ='
    if (text.includes('var eventsData =')) {
      return { success: true, data: text };
    }

    return { success: false };
  } catch (error) {
    return { success: false };
  }
}

async function run() {
  const nowInSeconds = Math.floor(Date.now() / 1000);
  console.log(`[INFO] Début du balayage à partir du timestamp actuel : ${toHexTimestamp(nowInSeconds)}`);

  let foundUrl = null;
  let validData = null;
  let validHex = null;
  let offsetFound = 0;

  // On boucle de 0 à MAX_LOOKBACK_SECONDS en arrière dans le temps
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
      break; // On a trouvé le bon lien, on arrête la boucle
    }
  }

  // Bilan et logs
  console.log('--------------------------------------------------');
  if (foundUrl) {
    console.log(`[SUCCÈS] Lien valide trouvé !`);
    console.log(`[LOG] Timestamp Valide (Hex) : ${validHex}`);
    console.log(`[LOG] Décalage détecté      : -${offsetFound} seconde(s)`);
    console.log(`[LOG] Lien fonctionnel       : ${foundUrl}`);
    console.log(`[LOG] Extrait du contenu     : ${validData.substring(0, 100)}...`);
    console.log('--------------------------------------------------');

    // Outputs pour GitHub Actions
    core.setOutput('hex_timestamp', validHex);
    core.setOutput('target_url', foundUrl);
    core.setOutput('events_data', validData);
  } else {
    console.log(`[ÉCHEC] Aucun lien valide trouvé sur les ${MAX_LOOKBACK_SECONDS} dernières secondes.`);
    console.log('--------------------------------------------------');
    core.setFailed(`Impossible de trouver un timestamp valide pour events.js`);
  }
}

run();
