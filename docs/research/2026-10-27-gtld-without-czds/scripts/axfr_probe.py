#!/usr/bin/env python3
"""One AXFR attempt per (zone, nameserver) pair, stdlib only. Reports rcode and what came back.

Usage: python -I axfr_probe.py <zone> <nameserver-host-or-ip> [<zone> <ns> ...]
Reads at most 256 KiB and 6 seconds per attempt, then closes. A zone that answers NOERROR with
records in the first message is "open". REFUSED / NOTAUTH / timeout / reset is "closed".
"""
import socket, struct, sys, time

def name(z):
    out = b''
    for l in z.strip('.').split('.'):
        if l:
            out += bytes([len(l)]) + l.encode('idna')
    return out + b'\x00'

def rd_name(b, o):
    labels, jumped, end = [], False, o
    while True:
        n = b[o]
        if n == 0:
            o += 1; break
        if n & 0xC0 == 0xC0:
            ptr = ((n & 0x3F) << 8) | b[o + 1]
            if not jumped:
                end = o + 2
            o, jumped = ptr, True
            continue
        labels.append(b[o + 1:o + 1 + n].decode('ascii', 'replace')); o += 1 + n
    return '.'.join(labels), (end if jumped else o)

def attempt(zone, ns):
    q = struct.pack('>HHHHHH', 0x4242, 0, 1, 0, 0, 0) + name(zone) + struct.pack('>HH', 252, 1)
    t0 = time.time()
    try:
        s = socket.create_connection((ns, 53), timeout=6)
    except Exception as e:
        return f'{zone} @{ns}: connect {type(e).__name__}'
    try:
        s.settimeout(6)
        s.sendall(struct.pack('>H', len(q)) + q)
        buf = b''
        while len(buf) < 2:
            c = s.recv(4096)
            if not c:
                return f'{zone} @{ns}: closed with no answer'
            buf += c
        ln = struct.unpack('>H', buf[:2])[0]
        while len(buf) < 2 + ln:
            c = s.recv(65536)
            if not c:
                break
            buf += c
        m = buf[2:2 + ln]
        flags, qd, an = struct.unpack('>HHH', m[2:8])
        rcode = flags & 0xF
        names = ''
        if rcode == 0 and an:
            o = 12
            for _ in range(qd):
                _, o = rd_name(m, o); o += 4
            n0, o = rd_name(m, o)
            rtype = struct.unpack('>H', m[o:o + 2])[0]
            names = f' first_rr={n0}/type{rtype}'
        return f'{zone} @{ns}: rcode={rcode} answers_in_first_msg={an} first_msg_bytes={ln}{names} t={time.time()-t0:.1f}s'
    except Exception as e:
        return f'{zone} @{ns}: {type(e).__name__} {e}'
    finally:
        s.close()

if __name__ == '__main__':
    a = sys.argv[1:]
    for z, ns in zip(a[0::2], a[1::2]):
        print(attempt(z, ns)); time.sleep(0.5)
