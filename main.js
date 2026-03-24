const { app, BrowserWindow } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let mainWindow;
let serverProcess;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "Cisco Codec AES67 Manager v0.9.0",
        autoHideMenuBar: true,
        backgroundColor: '#121212', // Set dark background immediately to avoid white flash
        webPreferences: {
            nodeIntegration: false, // Security best practice
            contextIsolation: true
        },
        icon: path.join(__dirname, 'icon.png') // Optional: if you have an icon
    });

    // Instantly load a dark "Please wait" screen using a data URI
    const loadingHtml = `data:text/html;charset=utf-8,
    <html>
    <body style="background-color: %23121212; color: white; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
        <div style="text-align: center;">
            <h2 style="margin-bottom: 10px; font-weight: 500;">Cisco Codec AES67 Manager</h2>
            <p style="color: %23888; font-size: 14px; margin: 0;">Hang tight, almost there!</p>
            <div style="margin-top: 20px; width: 40px; height: 40px; border: 4px solid %23333; border-top: 4px solid %23007bff; border-radius: 50%; animation: spin 1s linear infinite; margin-left: auto; margin-right: auto;"></div>
            <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
        </div>
    </body>
    </html>`;
    
    mainWindow.loadURL(loadingHtml);

    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

function startServer() {
    // Fork the server.js script
    serverProcess = fork(path.join(__dirname, 'server.js'), [], {
        silent: false // Let it print to console
    });

    serverProcess.on('message', (msg) => {
        if (msg.type === 'server-ready' && mainWindow) {
            const serverUrl = `http://localhost:${msg.port}`;
            const loadServer = () => {
                mainWindow.loadURL(serverUrl).catch(err => {
                    console.log('Server not ready yet, retrying...');
                    setTimeout(loadServer, 1000);
                });
            };
            loadServer();
        }
    });

    serverProcess.on('error', (err) => {
        console.error('Server process failed:', err);
    });
}

app.on('ready', () => {
    startServer();
    createWindow();
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', function () {
    if (mainWindow === null) {
        createWindow();
    }
});

app.on('will-quit', () => {
    if (serverProcess) {
        serverProcess.kill();
    }
});
