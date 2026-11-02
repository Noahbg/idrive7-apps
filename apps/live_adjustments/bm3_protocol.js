'use strict';
// BM3 CustomROM controls on the DME, from BM3 Live by ezl0l (idrive7-apps PR #29).

const DME = 0x12;
const MARKER_SIZE = 0xFF;

function addressBytes(value) {
    if (typeof value !== 'string' || !/^[0-9A-Fa-f]{8}$/.test(value)) throw new Error('invalid 32-bit address');
    return Array.from(Buffer.from(value, 'hex'));
}

function positive(reply, sid, prefix) {
    if (!reply) throw new Error('DME did not answer');
    if (reply[0] === 0x7F) throw new Error('DME rejected ' + sid.toString(16).toUpperCase() + ': NRC ' + reply[2].toString(16).toUpperCase().padStart(2, '0'));
    const want = [sid + 0x40].concat(prefix || []);
    if (want.some((b, i) => reply[i] !== b)) throw new Error('unexpected DME response: ' + Buffer.from(reply).toString('hex').toUpperCase());
    return reply;
}

function markerRom(reply, profiles) {
    positive(reply, 0x22, [0xF3, 0x01]);
    const data = Buffer.from(reply.slice(3));
    if (data.indexOf(Buffer.from('BM3_R')) < 0) throw new Error('BM3 CustomROM marker absent');
    const text = data.toString('latin1');
    const keys = Object.keys(profiles || {}).filter((key) => text.includes('#' + key));
    if (keys.length !== 1) {
        // name what the marker actually says, so an unlisted ROM can be reported and added
        const found = (text.match(/#[0-9A-Za-z]+/g) || []).join(' ');
        throw new Error(keys.length
            ? 'BM3 ROM not unique in marker (' + found + ')'
            : 'BM3 ROM not in the profile list (' + found + ') - add it to bm3_profiles.js');
    }
    return keys[0];
}

class Bm3Protocol {
    constructor(diag, profiles, config) {
        this.diag = diag;
        this.profiles = profiles;
        this.config = config || {};
        this.rom = null;
        this.profile = null;
        this._last = Promise.resolve();
    }

    /** Marker address candidates: the location is firmware-dependent (README), so the configured
     *  one is tried first, then the alternates. bm3MarkerAddress (single) keeps working;
     *  bm3MarkerAddresses (list) wins when both are set. */
    markerAddresses() {
        const list = Array.isArray(this.config.bm3MarkerAddresses) && this.config.bm3MarkerAddresses.length
            ? this.config.bm3MarkerAddresses.slice()
            : [this.config.bm3MarkerAddress || '807FFE50'];
        return list.filter((a) => /^[0-9A-Fa-f]{8}$/.test(String(a))).map(String);
    }

    _log(msg) { if (this.diag && this.diag.log && this.diag.log.info) this.diag.log.info('bm3: ' + msg); }

    /** Extended diagnostic session (10 03): some firmwares only take the 2C/23 memory jobs in
     *  it. Best effort - a refusal is logged and ignored (the reads are tried anyway). */
    async trySession() {
        try {
            const r = await this.diag.physical(DME, 0x10, [0x03], 2500,
                (u) => u[0] === 0x50 || (u[0] === 0x7F && u[1] === 0x10));
            this._log('session 10 03: ' + (r && r[0] === 0x50 ? 'ok' : r ? 'refused NRC ' + r[2].toString(16).toUpperCase().padStart(2, '0') : 'no answer'));
        } catch (e) { this._log('session 10 03: ' + (e && e.message || e)); }
    }

    /** One request at a time: a 0x63 reply carries no address, so two 0x23 reads in flight could
     * take each other's answers. */
    request(sid, data, prefix, timeoutMs) {
        const r = this._last.then(() => this._request(sid, data, prefix, timeoutMs));
        this._last = r.catch(() => {});
        return r;
    }

    async _request(sid, data, prefix, timeoutMs) {
        if (!this.diag.available) throw new Error('MGU diagnostic transport unavailable');
        const reply = await this.diag.physical(DME, sid, data, timeoutMs || 4500,
            (u) => (u[0] === sid + 0x40 && (prefix || []).every((b, i) => u[i + 1] === b))
                || (u[0] === 0x7F && u[1] === sid));
        return positive(reply, sid, prefix);
    }

    async identify() {
        this.profile = null;
        this.rom = null;
        await this.trySession();
        const tried = [];
        let marker = null, markerAddr = null;
        for (const cand of this.markerAddresses()) {
            const outcome = { address: cand };
            try {
                await this.request(0x2C, [0x02, 0xF3, 0x01, 0x24].concat(addressBytes(cand), [0, MARKER_SIZE]), [0x02, 0xF3, 0x01]);
                const reply = await this.request(0x22, [0xF3, 0x01], [0xF3, 0x01]);
                const text = Buffer.from(reply.slice(3)).toString('latin1');
                outcome.text = text.replace(/[^\x20-\x7e]/g, '.').slice(0, 96);
                if (text.indexOf('BM3_R') >= 0) { marker = reply; markerAddr = cand; }
            } catch (e) {
                outcome.error = String(e && e.message || e);
            }
            tried.push(outcome);
            this._log('marker @ ' + cand + ': ' + (outcome.error || ('"' + outcome.text + '"')));
            if (marker) break;
        }
        if (!marker) {
            throw new Error('BM3 CustomROM marker not found - ' + tried.map((o) => o.address + ' ' + (o.error || 'no BM3_R')).join(' | '));
        }
        const rom = markerRom(marker, this.profiles);
        const profile = this.profiles[rom];
        if (!profile || !profile.mapSwActAddr || profile.rom !== rom) throw new Error('BM3 profile unavailable');
        this.rom = rom;
        this.profile = profile;
        return { rom, markerAddress: markerAddr };
    }

    ready() {
        if (!this.profile || !this.rom) throw new Error('DME/BM3 profile not verified');
    }

    memoryWriteService() {
        this.ready();
        const command = String(this.profile.wmbaCmd || '3d').toLowerCase();
        if (command !== '3d' && command !== '3e') throw new Error('unsupported BM3 memory-write command');
        return parseInt(command, 16);
    }

    async writeProfileMemory(address, bytes) {
        const sid = this.memoryWriteService();
        if (!Array.isArray(bytes) || !bytes.length || bytes.length > 0xFF) throw new Error('invalid memory-write data');
        const prefix = sid === 0x3E ? [0x3D] : [];
        return this.request(sid, [0x14].concat(addressBytes(address), [bytes.length], bytes), prefix);
    }

    async currentMap() {
        this.ready();
        const addr = addressBytes(this.profile.mapSwActAddr);
        const r = await this.request(0x23, [0x14].concat(addr, [0x01]), []);
        const slot = r[1];
        if (r.length !== 2 || slot > 3) throw new Error('invalid map readback');
        return slot;
    }

    async setMap(slot) {
        this.ready();
        if (!Number.isInteger(slot) || slot < 0 || slot > 3) throw new Error('invalid map selection');
        await this.writeProfileMemory(this.profile.mapSwActAddr, [slot, 0x01]);
        const actual = await this.currentMap();
        if (actual !== slot) throw new Error('map readback differs: ' + (actual + 1));
        return actual;
    }

    async setFlap(mode) {
        const command = {
            open: [0x60, 0xFD, 0x03, 0x14, 0xFE],
            close: [0x60, 0xFD, 0x03, 0x23, 0x28],
            auto: [0x60, 0xFD, 0x00],
        }[mode];
        if (!command) throw new Error('invalid valve mode');
        await this.request(0x2F, command, command.slice(0, 3), 5500);
        return mode;
    }

    async setAsd(enabled) {
        await this.request(0x2E, [0x5F, 0xFD, enabled ? 0x00 : 0x01], [0x5F, 0xFD], 8000);
        return !!enabled;
    }

    burbleProfile() {
        this.ready();
        const table = this.profile.liveTuneTables && this.profile.liveTuneTables.KF_DZWMIN_SPORT_SOT;
        if (!table || !table.address || !this.profile.burbleActAddr) throw new Error('BM3 burble profile unavailable');
        const factor = Number(table.factor);
        if (!Number.isFinite(factor) || factor <= 0 || 12 * factor > 127) throw new Error('invalid BM3 burble factor');
        return {
            enableAddress: this.profile.burbleActAddr,
            timingAddress: table.address,
            factor,
        };
    }

    async readBurbles() {
        const p = this.burbleProfile();
        const enabled = await this.request(0x23, [0x14].concat(addressBytes(p.enableAddress), [0x01]), []);
        const timing = await this.request(0x23, [0x14].concat(addressBytes(p.timingAddress), [0x18]), []);
        if (enabled.length !== 2 || (enabled[1] !== 0 && enabled[1] !== 1) || timing.length !== 25) {
            throw new Error('invalid burble readback');
        }
        const values = Array.from(timing.slice(1));
        const byte = values[0];
        const signed = byte >= 128 ? byte - 256 : byte;
        const aggression = values.every((v) => v === byte) && signed <= 0 ? -signed / p.factor : null;
        return { enabled: enabled[1] === 1, timing: values, aggression };
    }

    async setBurbles(aggression) {
        if (aggression !== null && (!Number.isInteger(aggression * 2) || aggression < 0 || aggression > 12)) {
            throw new Error('burble aggression must be 0 to 12 in 0.5 steps');
        }
        const p = this.burbleProfile();
        const enabled = aggression !== null;
        const value = enabled ? Math.trunc(-Math.abs(aggression * p.factor)) & 0xFF : 0x00;
        const timing = Array(24).fill(value);
        await this.writeProfileMemory(p.enableAddress, [enabled ? 1 : 0]);
        await this.writeProfileMemory(p.timingAddress, timing);
        const actual = await this.readBurbles();
        if (actual.enabled !== enabled || actual.timing.some((b) => b !== value)) {
            throw new Error('burble readback differs from requested preset');
        }
        return aggression;
    }
}

module.exports = { Bm3Protocol, markerRom, addressBytes, positive };
