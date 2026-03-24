const express = require('express');
const jsxapi = require('jsxapi');
const path = require('path');

const app = express();
let port = 3987; // Default to 3987

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files
app.use(express.static(__dirname));

// Global xapi connection
let xapi = null;
let currentIp = null;
let sseClients = [];

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// SSE Endpoint
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientId = Date.now();
    const newClient = {
        id: clientId,
        res
    };
    sseClients.push(newClient);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c.id !== clientId);
        if (sseClients.length === 0 && xapi) {
            console.log('All clients disconnected. Stopping VU meters.');
            xapi.Command.Audio.VuMeter.StopAll().catch(e => {});
        }
    });
});

function broadcastEvent(type, data) {
    sseClients.forEach(client => {
        client.res.write(`event: ${type}\n`);
        client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    });
}

app.post('/api/login', (req, res) => {
    const { ip, username, password } = req.body;

    if (xapi) {
        try { xapi.close(); } catch(e) {}
        xapi = null;
    }

    console.log(`Connecting to ${ip}...`);
    
    // Handle both raw IP and wss:// prefix
    const connectionString = ip.includes('://') ? ip : `wss://${ip}`;

    try {
        const newXapi = jsxapi.connect(connectionString, {
            username,
            password,
            rejectUnauthorized: false
        });

        let responded = false;

        newXapi.on('error', (err) => {
            console.error('XAPI Error:', err);
            if (!responded) {
                responded = true;
                res.status(500).json({ error: err.message || 'Connection failed' });
            }
        });

        newXapi.on('ready', async () => {
            console.log('Connected!');
            xapi = newXapi;
            currentIp = ip;
            if (!responded) {
                responded = true;
                res.json({ success: true, ip });
            }

            // Start VU Meters
            try {
                // Ensure all meters are stopped before starting new ones
                await xapi.Command.Audio.VuMeter.StopAll().catch(e => {});

                for (let i = 1; i <= 8; i++) {
                    xapi.Command.Audio.VuMeter.Start({
                        ConnectorId: i,
                        ConnectorType: 'Ethernet',
                        Source: 'BeforeAEC'
                    }).catch(e => {}); // Ignore errors for unused channels
                }
                console.log('VU Meters started (BeforeAEC)');
            } catch (e) {
                console.error('Error starting VU meters:', e);
            }

            // Listen for VU Meter events
            // Event path: xEvent/Audio/Input/Connectors/Ethernet
            xapi.Event.Audio.Input.Connectors.Ethernet.on(event => {
                // event structure: { id: '1', SubId: [ { id: '1', VuMeter: '20' } ] }
                // or sometimes nested differently depending on jsxapi version/parsing
                // Let's broadcast what we get and handle parsing in frontend or here.
                // Based on user log: {"Input":{"Connectors":{"Ethernet":[{"SubId":[{"LoudspeakerActivity":"0","NoiseLevel":"19","PPMeter":"31","VuMeter":"20","id":"1"}],"id":"1"}],"id":"1"},"id":"1"},"id":"1"}
                // jsxapi usually strips the top level if we listen to specific path.
                
                // If we listen to xapi.Event.Audio.Input.Connectors.Ethernet, 'event' should be the object inside Ethernet array?
                // Actually jsxapi .on() usually returns the payload.
                
                broadcastEvent('vu_meter', event);
            });
        });

        // Timeout if not connected in 10 seconds
        setTimeout(() => {
            if (!responded) {
                responded = true;
                // Close if pending
                try { newXapi.close(); } catch(e) {}
                res.status(504).json({ error: 'Connection timed out' });
            }
        }, 10000);

    } catch (err) {
        console.error('Login exception:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/logout', (req, res) => {
    if (xapi) {
        try { xapi.close(); } catch(e) {}
        xapi = null;
        currentIp = null;
    }
    res.json({ success: true });
});

// Middleware to check connection
const checkConnection = (req, res, next) => {
    if (!xapi) {
        return res.status(401).json({ error: 'Not connected to device' });
    }
    next();
};

app.post('/api/config', checkConnection, async (req, res) => {
    const { path, value } = req.body;
    try {
        // path: 'Audio.Ethernet.SAPDiscovery.Mode'
        const parts = path.split('.');
        let node = xapi.Config;
        for (const part of parts) {
            node = node[part];
        }
        await node.set(value);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/config', checkConnection, async (req, res) => {
    const { path } = req.query;
    try {
        const parts = path.split('.');
        let node = xapi.Config;
        for (const part of parts) {
            node = node[part];
        }
        const result = await node.get();
        res.json({ result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/streams/input', checkConnection, async (req, res) => {
    try {
        const streams = await xapi.Status.Audio.Input.Ethernet.DiscoveredStream.get();
        res.json({ result: streams });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/streams/output', checkConnection, async (req, res) => {
    try {
        const streams = await xapi.Status.Audio.Output.Connectors.Ethernet.get();
        res.json({ result: streams });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- New Endpoints for Management ---

// Get Connected Input Channels
app.get('/api/streams/input/connected', checkConnection, async (req, res) => {
    try {
        // Changed from Status.Audio.Input.Ethernet.Channel to Status.Audio.Input.Connectors.Ethernet
        const channels = await xapi.Status.Audio.Input.Connectors.Ethernet.get();
        res.json({ result: channels });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Connect an Input Stream
app.post('/api/streams/input/connect', checkConnection, async (req, res) => {
    const { name, channel } = req.body;
    try {
        // PDF Page 8: xCommand Audio LocalInput Ethernet Register StreamName: "..."
        // Optional: ConnectorId
        const args = { StreamName: name };
        if (channel) {
            const cId = parseInt(channel);
            if (!isNaN(cId)) {
                args.ConnectorId = cId;
            }
        }

        await xapi.Command.Audio.LocalInput.Ethernet.Register(args);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Disconnect an Input Stream
app.post('/api/streams/input/disconnect', checkConnection, async (req, res) => {
    const { channel } = req.body;
    try {
        // PDF Page 8: xCommand Audio LocalInput Ethernet Deregister ConnectorId: n
        await xapi.Command.Audio.LocalInput.Ethernet.Deregister({ ConnectorId: parseInt(channel) });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Output Configuration (Actually Status of Active Outputs)
app.get('/api/streams/output/config', checkConnection, async (req, res) => {
    try {
        // PDF Page 9: xStatus Audio Output Connectors Ethernet
        const status = await xapi.Status.Audio.Output.Connectors.Ethernet.get();
        console.log('Output Streams Status:', JSON.stringify(status, null, 2));
        res.json({ result: status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Set Output Configuration (Edit = Deregister + Register)
app.post('/api/streams/output/config', checkConnection, async (req, res) => {
    const { channel, name, ipAddress } = req.body;
    
    // Enforce 239.69.x.x IP range restriction
    const ipPattern = /^239\.69\.([0-9]{1,3})\.([0-9]{1,3})$/;
    const match = ipAddress.match(ipPattern);
    if (!match || match[1] > 255 || match[2] > 255) {
        return res.status(400).json({ error: 'IP Address must be in the 239.69.X.X range.' });
    }

    try {
        // PDF Page 9: To edit, we must Deregister then Register.
        
        // 1. Deregister existing (ignore error if it doesn't exist or fails)
        try {
            await xapi.Command.Audio.LocalOutput.Ethernet.Deregister({ ConnectorId: parseInt(channel) });
        } catch (e) { console.log('Deregister warning:', e.message); }

        // 2. Register new
        // xCommand Audio LocalOutput Ethernet Register StreamName: ... MediaIp: ...
        // Note: ConnectorId is not a valid argument for Register. The system assigns the ID.
        await xapi.Command.Audio.LocalOutput.Ethernet.Register({ 
            StreamName: name,
            MediaIp: ipAddress,
            Channels: 1 // Defaulting to 1 channel
        });
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Disconnect an Output Stream (Deregister)
app.post('/api/streams/output/disconnect', checkConnection, async (req, res) => {
    const { channel } = req.body;
    try {
        await xapi.Command.Audio.LocalOutput.Ethernet.Deregister({ ConnectorId: parseInt(channel) });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const server = app.listen(port);

server.on('listening', () => {
    const currentPort = server.address().port;
    console.log(`Server running at http://localhost:${currentPort}`);
    if (process.send) {
        process.send({ type: 'server-ready', port: currentPort });
    }
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.log(`Port ${port} is in use, assigning a dynamic port...`);
        setTimeout(() => {
            server.close();
            server.listen(0); // 0 means OS assigns a random available port
        }, 1000);
    } else {
        console.error(e);
    }
});
