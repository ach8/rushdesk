const localtunnel = require('localtunnel');
const { execSync } = require('child_process');

(async () => {
    try {
        console.log("Starting localtunnel on port 8765...");
        const tunnel = await localtunnel({ port: 8765 });
        console.log("TUNNEL_ACTIVE_URL:" + tunnel.url);
        
        // Mise à jour de Twilio
        const output = execSync(`python start_twilio.py ${tunnel.url}`).toString();
        console.log(output);

        tunnel.on('close', () => {
            console.log("Tunnel closed");
        });
        
        tunnel.on('error', (err) => {
            console.error("Tunnel error event:", err);
        });
    } catch (e) {
        console.error("Tunnel error:", e);
    }
})();
