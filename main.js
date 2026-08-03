import * as core from '@actions/core';

function getHexTimestamp() {
  // Timestamp actuel en secondes (arrondi à l'entier inférieur)
  const epochSeconds = Math.floor(Date.now() / 1000);
  
  // Conversion en hexadécimal (sur 8 caractères, rempli de '0' au besoin)
  return epochSeconds.toString(16).toUpperCase().padStart(8, '0');
}

function run() {
  try {
    const hexTimestamp = getHexTimestamp();
    const targetUrl = `https://wt3.test.fr//realtime/${hexTimestamp}/events.js`;

    // Logs visibles dans la console GitHub Actions
    console.log(`[INFO] Timestamp Hex généré : ${hexTimestamp}`);
    console.log(`[INFO] URL finale générée  : ${targetUrl}`);

    // Export sous forme de variable d'output GitHub Actions (utile si d'autres étapes en ont besoin)
    core.setOutput('hex_timestamp', hexTimestamp);
    core.setOutput('target_url', targetUrl);
  } catch (error) {
    core.setFailed(`Erreur lors de l'exécution : ${error.message}`);
  }
}

run();
