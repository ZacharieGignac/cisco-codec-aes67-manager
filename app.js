// DOM Elements
const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const loginBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const loginError = document.getElementById('login-error');
const deviceAddressSpan = document.getElementById('device-address');

// Stream Tables
const inputStreamsTableBody = document.querySelector('#input-streams-table tbody');
const connectedInputsTableBody = document.querySelector('#connected-inputs-table tbody');
const outputStreamsTableBody = document.querySelector('#output-streams-table tbody');

const refreshInputsBtn = document.getElementById('refresh-inputs-btn');
const refreshConnectedInputsBtn = document.getElementById('refresh-connected-inputs-btn');
const refreshOutputsBtn = document.getElementById('refresh-outputs-btn');

// Modal Elements
const editModal = document.getElementById('edit-modal');
const editChannelId = document.getElementById('edit-channel-id');
const editName = document.getElementById('edit-name');
const editIp3 = document.getElementById('edit-ip-3');
const editIp4 = document.getElementById('edit-ip-4');
const saveOutputBtn = document.getElementById('save-output-btn');
const cancelEditBtn = document.getElementById('cancel-edit-btn');

// Event Listeners
console.log('[CLIENT] Setting up event listeners');
loginBtn.addEventListener('click', () => {
    console.log('[CLIENT] Connect button clicked!');
    handleLogin();
});
disconnectBtn.addEventListener('click', handleDisconnect);

// Allow Enter key to trigger login
document.getElementById('password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
});
document.getElementById('username').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
});
document.getElementById('device-ip').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
});

refreshInputsBtn.addEventListener('click', fetchInputStreams);
refreshConnectedInputsBtn.addEventListener('click', fetchConnectedInputs);
refreshOutputsBtn.addEventListener('click', fetchOutputStreams);

saveOutputBtn.addEventListener('click', saveOutputConfig);
cancelEditBtn.addEventListener('click', () => editModal.classList.remove('active'));

// --- API Helpers ---

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function apiGet(url) {
    console.log('[CLIENT] apiGet:', url);
    const res = await fetch(url);
    console.log('[CLIENT] apiGet response status:', res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
}

async function apiPost(url, body) {
    console.log('[CLIENT] apiPost:', url, 'body:', body);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        console.log('[CLIENT] apiPost response status:', res.status);
        const data = await res.json();
        console.log('[CLIENT] apiPost response data:', data);
        if (data.error) throw new Error(data.error);
        return data;
    } catch (err) {
        console.error('[CLIENT] apiPost failed:', err);
        throw err;
    }
}

// --- Main Logic ---

async function handleLogin() {
    console.log('[CLIENT] handleLogin called');
    const ip = document.getElementById('device-ip').value.trim();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    
    console.log('[CLIENT] Form values:', { ip, username: username ? '***' : '', password: password ? '***' : '' });

    if (!ip || !username || !password) {
        console.log('[CLIENT] Validation failed - missing fields');
        showError('Please fill in all fields');
        return;
    }

    console.log('[CLIENT] Validation passed, starting login...');
    showError('');
    loginBtn.textContent = 'Connecting...';
    loginBtn.disabled = true;

    try {
        console.log('[CLIENT] Calling apiPost /api/login');
        const data = await apiPost('/api/login', { ip, username, password });
        console.log('[CLIENT] Login API responded:', data);
        
        console.log('Login successful');
        
        // Ensure mandatory settings first
        const sapRes = await apiGet('/api/config?path=Audio.Ethernet.SAPDiscovery.Mode');
        const encRes = await apiGet('/api/config?path=Audio.Ethernet.Encryption');
        
        const sapMode = sapRes.result;
        const encryption = encRes.result;

        if (sapMode !== 'On' || encryption !== 'Optional') {
            const confirmed = await showDialog(
                'confirm', 
                'Required Settings', 
                `This tool requires "AES67 SAP Discovery" to be ON, and "AES67 Encryption" to be OPTIONAL.<br><Br>The current Codec configuration doesn't match this requirement. Do you allow this tool to change these settings on the device?`
            );

            if (!confirmed) {
                // User refused, disconnect and reset
                await handleDisconnect();
                return;
            }

            // User accepted, apply settings
            if (sapMode !== 'On') {
                await apiPost('/api/config', { path: 'Audio.Ethernet.SAPDiscovery.Mode', value: 'On' });
            }
            if (encryption !== 'Optional') {
                await apiPost('/api/config', { path: 'Audio.Ethernet.Encryption', value: 'Optional' });
            }
            
            showToast('Codec configured for AES67 automatically.');
        }

        loginScreen.classList.remove('active');
        dashboardScreen.classList.add('active');
        deviceAddressSpan.textContent = data.ip;
        
        loadInitialData();
        startEventStream();

    } catch (err) {
        console.error('[CLIENT] Login error:', err);
        console.error('[CLIENT] Error stack:', err.stack);
        showError('Connection failed: ' + err.message);
        loginBtn.textContent = 'Connect';
        loginBtn.disabled = false;
    }
}

console.log('[CLIENT] app.js loaded, loginBtn:', loginBtn);

function startEventStream() {
    const evtSource = new EventSource('/api/events');
    
    evtSource.addEventListener('vu_meter', (e) => {
        try {
            const data = JSON.parse(e.data);
            // data structure from jsxapi event listener on Audio.Input.Connectors.Ethernet
            // It might be { id: '1', SubId: [...] }
            
            const connectorId = data.id;
            if (!connectorId) return;

            // SubId is an array of channels (e.g. Left/Right)
            const subIds = Array.isArray(data.SubId) ? data.SubId : [data.SubId];
            
            // Calculate average or max if multiple channels, or just take the first one for now
            // The user example shows: "SubId":[{"LoudspeakerActivity":"0","NoiseLevel":"19","PPMeter":"31","VuMeter":"20","id":"1"}]
            
            let maxVu = 0;
            subIds.forEach(sub => {
                if (sub && sub.VuMeter) {
                    const val = parseInt(sub.VuMeter);
                    if (!isNaN(val) && val > maxVu) maxVu = val;
                }
            });

            // Update UI
            // Find the VU meter bar for this connector ID
            const bar = document.getElementById(`vu-bar-${connectorId}`);
            if (bar) {
                // VU Meter range is typically -60dB to 0dB represented as 0-100 or similar?
                // Actually Cisco VU meter is often 0-60 or 0-100. 
                // Let's assume 0-60 based on typical audio levels, or just map directly to %.
                // If the value is e.g. 20, and max is say 60.
                // Let's try direct percentage first, capping at 100.
                const percentage = Math.min(100, Math.max(0, maxVu * 2)); // Multiply by 2 to make it more visible if range is low
                // Since we use a mask now to reveal the background, width of mask is (100 - level)%
                bar.style.width = `${100 - percentage}%`;
            }

        } catch (err) {
            console.error('Error parsing SSE data', err);
        }
    });

    evtSource.onerror = (err) => {
        console.error('EventSource failed:', err);
        // Optional: reconnect logic is built-in to EventSource usually
    };
}

async function handleDisconnect() {
    try {
        await apiPost('/api/logout', {});
    } catch (e) { console.error(e); }
    window.location.reload();
}

function showError(msg) {
    loginError.textContent = msg;
}

async function loadInitialData() {
    // Streams
    // Fetch connected inputs first to populate cache
    await fetchConnectedInputs();
    // Then fetch discovered streams
    fetchInputStreams();
    fetchOutputStreams();
}

// --- Input Streams ---

let connectedStreamsCache = [];
let connectedChannelIdsCache = [];

async function fetchConnectedInputs() {
    connectedInputsTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center">Loading...</td></tr>';
    try {
        const data = await apiGet('/api/streams/input/connected');
        let channels = data.result || [];
        if (!Array.isArray(channels)) channels = [channels];
        
        // Cache for use in renderInputStreams
        connectedStreamsCache = [];
        connectedChannelIdsCache = [];
        
        channels.forEach(ch => {
            const streamName = ch.StreamName || (ch.Connect ? ch.Connect.Name : null) || '';
            if (streamName !== '') {
                connectedStreamsCache.push(streamName);
                if (ch.id) connectedChannelIdsCache.push(ch.id.toString());
            }
        });

        renderConnectedInputs(channels);
        
        // Refresh discovered list to update button states if we have them
        if (inputStreamsTableBody.children.length > 0 && !inputStreamsTableBody.innerHTML.includes('Loading')) {
             // Trigger a re-render if we already have data, or just let the user refresh. 
             // Better yet, let's just re-fetch inputs to be safe and keep UI in sync
             fetchInputStreams();
        }

    } catch (err) {
        connectedInputsTableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--danger-color)">Error: ${err.message}</td></tr>`;
    }
}

function renderConnectedInputs(channels) {
    connectedInputsTableBody.innerHTML = '';
    if (channels.length === 0) {
        connectedInputsTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--text-secondary)">No inputs connected</td></tr>';
        return;
    }

    channels.forEach(ch => {
        // Check for different property names depending on API version
        // Status.Audio.Input.Connectors.Ethernet usually returns { id: '1', StreamName: '...' } or similar
        // Or maybe { id: '1', Connect: { Name: '...' } }
        
        // Let's try to handle both or inspect
        const streamName = ch.StreamName || (ch.Connect ? ch.Connect.Name : null) || '-';
        const isConnected = streamName !== '-' && streamName !== '';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${ch.id}</td>
            <td>${streamName}</td>
            <td><span class="badge ${isConnected ? 'connected' : 'disconnected'}">${isConnected ? 'Connected' : 'Disconnected'}</span></td>
            <td>
                <div class="vu-meter-container">
                    <div id="vu-bar-${ch.id}" class="vu-meter-bar-mask" style="width: 100%;"></div>
                </div>
            </td>
            <td>
                ${isConnected ? `<button class="action-btn secondary-btn" onclick="disconnectInput('${ch.id}')">Disconnect</button>` : '-'}
            </td>
        `;
        connectedInputsTableBody.appendChild(tr);
    });
}

async function fetchInputStreams() {
    inputStreamsTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center">Loading...</td></tr>';
    try {
        const data = await apiGet('/api/streams/input');
        let streams = data.result || [];
        if (!Array.isArray(streams)) streams = [streams];
        renderInputStreams(streams);
    } catch (err) {
        inputStreamsTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--danger-color)">Error: ${err.message}</td></tr>`;
    }
}

function renderInputStreams(streams) {
    inputStreamsTableBody.innerHTML = '';
    if (streams.length === 0) {
        inputStreamsTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-secondary)">No streams discovered</td></tr>';
        return;
    }

    streams.forEach(stream => {
        const isAlreadyConnected = connectedStreamsCache.includes(stream.Name);

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${stream.id || '-'}</td>
            <td>${stream.Name || '-'}</td>
            <td>${stream.MediaIP || '-'}</td>
            <td>${stream.OriginIP || '-'}</td>
            <td>${stream.Channels || '-'}</td>
            <td>
                ${isAlreadyConnected 
                    ? '<span class="badge connected">Connected</span>' 
                    : `<button class="action-btn" onclick="connectInput('${stream.Name}')">Connect</button>`
                }
            </td>
        `;
        inputStreamsTableBody.appendChild(tr);
    });
}

// --- Dialog Helpers ---

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    // Remove after 3 seconds
    setTimeout(() => {
        toast.classList.add('hiding');
        toast.addEventListener('animationend', () => {
            toast.remove();
        });
    }, 3000);
}

function showDialog(type, title, message, defaultValue = '') {
    return new Promise((resolve) => {
        const modal = document.getElementById('dialog-modal');
        const titleEl = document.getElementById('dialog-title');
        const msgEl = document.getElementById('dialog-message');
        const inputContainer = document.getElementById('dialog-input-container');
        const optionsContainer = document.getElementById('dialog-options-container');
        const input = document.getElementById('dialog-input');
        const okBtn = document.getElementById('dialog-ok-btn');
        const cancelBtn = document.getElementById('dialog-cancel-btn');

        titleEl.textContent = title;
        msgEl.innerHTML = message.replace(/\n/g, '<br>');
        input.value = defaultValue;

        // Reset state
        inputContainer.style.display = 'none';
        optionsContainer.style.display = 'none';
        optionsContainer.innerHTML = '';
        cancelBtn.style.display = 'none';
        okBtn.style.display = 'inline-block'; // Default show
        
        okBtn.onclick = null;
        cancelBtn.onclick = null;

        const close = (value) => {
            modal.classList.remove('active');
            resolve(value);
        };

        if (type === 'alert') {
            okBtn.onclick = () => close(true);
            okBtn.textContent = 'OK';
        } else if (type === 'confirm') {
            cancelBtn.style.display = 'inline-block';
            okBtn.textContent = 'Yes';
            cancelBtn.textContent = 'No';
            okBtn.onclick = () => close(true);
            cancelBtn.onclick = () => close(false);
        } else if (type === 'prompt') {
            inputContainer.style.display = 'block';
            cancelBtn.style.display = 'inline-block';
            okBtn.textContent = 'OK';
            cancelBtn.textContent = 'Cancel';
            okBtn.onclick = () => close(input.value);
            cancelBtn.onclick = () => close(null);
            setTimeout(() => input.focus(), 100);
        } else if (type === 'channel-picker') {
            optionsContainer.style.display = 'grid';
            optionsContainer.className = 'dialog-options-grid';
            
            // Auto button
            const autoBtn = document.createElement('button');
            autoBtn.className = 'channel-btn auto';
            autoBtn.textContent = 'Auto (Next Available)';
            autoBtn.onclick = () => close('');
            optionsContainer.appendChild(autoBtn);

            // 1-8 buttons
            for (let i = 1; i <= 8; i++) {
                const btn = document.createElement('button');
                btn.className = 'channel-btn';
                const isChannelUsed = connectedChannelIdsCache.includes(i.toString());
                
                if (isChannelUsed) {
                    btn.textContent = `Ch ${i} (In Use)`;
                    btn.disabled = true;
                    btn.title = "This channel is already in use.";
                } else {
                    btn.textContent = `Ch ${i}`;
                    btn.onclick = () => close(i.toString());
                }
                
                optionsContainer.appendChild(btn);
            }

            cancelBtn.style.display = 'inline-block';
            okBtn.style.display = 'none'; // Hide OK, selection is immediate
            cancelBtn.textContent = 'Cancel';
            cancelBtn.onclick = () => close(null);
        }

        modal.classList.add('active');
    });
}

// Global functions for onclick handlers
window.connectInput = async (name) => {
    const channel = await showDialog('channel-picker', 'Connect Stream', `Select a channel for stream "<b>${name}</b>":`);
    
    if (channel === null) return; // User cancelled

    try {
        const body = { name };
        if (channel.trim() !== '') {
            body.channel = channel.trim();
        }

        await apiPost('/api/streams/input/connect', body);
        showToast('Connected successfully');
        await sleep(1000); // Wait for codec to update status
        fetchConnectedInputs();
    } catch (err) {
        await showDialog('alert', 'Error', 'Failed to connect: ' + err.message);
    }
};

window.disconnectInput = async (channelId) => {
    const confirmed = await showDialog('confirm', 'Disconnect', `Disconnect channel ${channelId}?`);
    if (!confirmed) return;
    
    try {
        await apiPost('/api/streams/input/disconnect', { channel: channelId });
        showToast('Disconnected successfully');
        await sleep(1000); // Wait for codec to update status
        fetchConnectedInputs();
    } catch (err) {
        await showDialog('alert', 'Error', 'Failed to disconnect: ' + err.message);
    }
};

// --- Output Streams ---

async function fetchOutputStreams() {
    outputStreamsTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center">Loading...</td></tr>';
    try {
        // We want the CONFIGURATION, not just status
        const data = await apiGet('/api/streams/output/config');
        let channels = data.result || [];
        if (!Array.isArray(channels)) channels = [channels];
        renderOutputStreams(channels);
    } catch (err) {
        outputStreamsTableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--danger-color)">Error: ${err.message}</td></tr>`;
    }
}

function renderOutputStreams(channels) {
    outputStreamsTableBody.innerHTML = '';
    
    // Determine the range of IDs to display
    // Always show at least 1-4 (standard for Codec Pro)
    // Also include any IDs found in the response that are outside this range
    const foundIds = channels.map(c => parseInt(c.id)).filter(n => !isNaN(n));
    const maxId = Math.max(4, ...foundIds);

    for (let i = 1; i <= maxId; i++) {
        const id = i.toString();
        // Use loose comparison (==) to match string '2' with number 2
        const ch = channels.find(c => c.id == id) || {};
        
        // Properties from xStatus Audio Output Connectors Ethernet are StreamName and MediaIP
        const name = ch.StreamName || '-';
        const ip = ch.MediaIP || '-';
        const isConfigured = name !== '-' && ip !== '-';
        const isProtected = ip === '239.0.1.1';

        const tr = document.createElement('tr');
        
        let actionsHtml = '';
        if (isProtected) {
            actionsHtml = '<span class="badge" style="background-color: #666; color: #ccc; cursor: not-allowed;" title="System Stream">Protected</span>';
        } else if (isConfigured) {
            actionsHtml = `
                <button class="action-btn secondary-btn" onclick="openEditModal('${id}', '${name}', '${ip}')">Edit</button>
                <button class="action-btn danger-btn" onclick="removeOutput('${id}')" style="margin-left: 5px; background-color: #d32f2f;">Remove</button>
            `;
        } else {
            actionsHtml = `
                <button class="action-btn" onclick="openEditModal('${id}', '', '')">Add</button>
            `;
        }

        tr.innerHTML = `
            <td>${id}</td>
            <td>${name}</td>
            <td>${ip}</td>
            <td>${actionsHtml}</td>
        `;
        outputStreamsTableBody.appendChild(tr);
    }
}

window.openEditModal = (id, name, ip) => {
    editChannelId.value = id;
    editName.value = name;
    
    // Parse IP for edit form
    if (ip) {
        const ipPattern = /^239\.69\.([0-9]{1,3})\.([0-9]{1,3})$/;
        const match = ip.match(ipPattern);
        if (match) {
            editIp3.value = match[1];
            editIp4.value = match[2];
        } else {
            editIp3.value = '';
            editIp4.value = '';
        }
    } else {
        editIp3.value = '';
        editIp4.value = '';
    }
    
    // Set placeholders if adding new
    if (!name && !ip) {
        editName.placeholder = "e.g. AES67 Stream 1";
        document.querySelector('#edit-modal h3').textContent = `Add Output Stream (Channel ${id})`;
    } else {
        editName.placeholder = "";
        document.querySelector('#edit-modal h3').textContent = `Edit Output Stream (Channel ${id})`;
    }
    
    editModal.classList.add('active');
};

window.removeOutput = async (id) => {
    const confirmed = await showDialog('confirm', 'Remove Output', `Are you sure you want to remove output stream on channel ${id}?`);
    if (!confirmed) return;
    
    try {
        await apiPost('/api/streams/output/disconnect', { channel: id });
        showToast('Output stream removed');
        await sleep(1000); // Wait for codec to update status
        fetchOutputStreams();
    } catch (err) {
        await showDialog('alert', 'Error', 'Failed to remove: ' + err.message);
    }
};

async function saveOutputConfig() {
    const id = editChannelId.value;
    const name = editName.value;
    
    const v3 = editIp3.value;
    const v4 = editIp4.value;

    if (v3 === '' || v4 === '' || v3 < 0 || v3 > 255 || v4 < 0 || v4 > 255) {
        await showDialog('alert', 'Error', 'Both IP octets must be numbers between 0 and 255.');
        return;
    }

    const ip = `239.69.${v3}.${v4}`;

    saveOutputBtn.textContent = 'Saving...';
    saveOutputBtn.disabled = true;

    try {
        await apiPost('/api/streams/output/config', {
            channel: id,
            name: name,
            ipAddress: ip
        });
        
        editModal.classList.remove('active');
        showToast('Configuration saved');
        await sleep(1000); // Wait for codec to update status
        fetchOutputStreams();
    } catch (err) {
        await showDialog('alert', 'Error', 'Failed to save: ' + err.message);
    } finally {
        saveOutputBtn.textContent = 'Save';
        saveOutputBtn.disabled = false;
    }
}
