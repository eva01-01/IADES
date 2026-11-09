# IADESIGN

## Private local-network studio (Windows)

The host PC runs the web application, stores SQLite data and uploaded images, and connects to local Ollama and ComfyUI. Other devices need only a modern browser and must be on the same trusted Wi-Fi network. Keep the host PC and required AI services running while the studio is in use.

1. Install Node.js (LTS), then install Ollama and ComfyUI on the host PC.
2. In Ollama, install a compatible text model (for example, `ollama pull qwen2.5:3b`). In ComfyUI, install a supported image checkpoint. Start both services on the host PC.
3. From the project folder, run `start-lan.cmd`. It builds and starts the private server on port `4174`; keep the command window open.
4. Open one of the `http://<host-IP>:4174` addresses printed in the server window on the host or another device on the same Wi-Fi. If Windows Firewall asks, allow Node.js only on Private networks. Do not create a public firewall rule or router port-forward.
5. The first visit asks you to create the owner account using the one-time setup code printed in the server window. The owner can create separate member accounts. Sign in with the account assigned to you.
6. In AI settings, check Ollama and ComfyUI status and select the installed text model and image checkpoint. These services run on the host PC; browsers send requests only to this studio, not directly to the AI services.

The LAN mode uses HTTP and is intended only for a trusted private Wi-Fi network. Do not expose port `4174` to the public Internet or use a public tunnel. Prompts and images are kept on the host and sent only to the local Ollama/ComfyUI services; remote AI-provider mode is disabled. The host must remain powered on, and AI tasks will report an unavailable-service/model diagnostic until the required local service and model are ready.

Data is stored in the `data` folder on the host PC. Before account ownership migration, the server makes a one-time `data/studio.sqlite.pre-auth-migration.bak` copy when a database already exists. Back up the entire `data` folder regularly and stop the server before copying it. Keep this backup outside the project folder as well.

For loopback-only development, use `npm run dev`; it is not accessible to other devices on the Wi-Fi.
