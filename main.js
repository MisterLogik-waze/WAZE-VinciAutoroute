import * as core from '@actions/core';

/**
 * Génère les informations de timestamp et d'URL
 */
function generateTrafficLink() {
  const now = new Date();
  
  // Timestamp Unix en secondes
  const epochSeconds = Math.floor(now.getTime() / 1000);
  
  // Conversion en hexadécimal majuscule (8 caractères)
  const hexTimestamp = epochSeconds.toString(16).toUpperCase().padStart(8, '0');

  // Formatage lisible des dates pour les logs
  const timeUTC = now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  const timeParis = now.toLocaleString('fr-FR', { 
    timeZone: 'Europe/Paris', 
    dateStyle: 'short', 
    timeStyle: 'medium' 
  });

  // URL définitive (double slash conservé strict)
  const targetUrl = `https://wt3.autoroutes-trafic.fr//realtime/trafficevents/${hexTimestamp}/events.js`;

  return {
    timeUTC,
    timeParis,
    hexTimestamp,
    targetUrl
  };
}

function run() {
  try {
    const { timeUTC, timeParis, hexTimestamp, targetUrl } = generateTrafficLink();

    // Log clair dans la console GitHub Actions
    console.log('--------------------------------------------------');
    console.log(`[LOG] Heure détectée (UTC)   : ${timeUTC}`);
    console.log(`[LOG] Heure détectée (Paris) : ${timeParis}`);
    console.log(`[LOG] Timestamp (Hex)        : ${hexTimestamp}`);
    console.log(`[LOG] Lien définitif         : ${targetUrl}`);
    console.log('--------------------------------------------------');

    // Transmission des variables aux étapes suivantes du workflow si besoin
    core.setOutput('time_utc', timeUTC);
    core.setOutput('time_paris', timeParis);
    core.setOutput('hex_timestamp', hexTimestamp);
    core.setOutput('target_url', targetUrl);

  } catch (error) {
    core.setFailed(`[ERREUR] Impossible de générer le lien : ${error.message}`);
  }
}

run();
