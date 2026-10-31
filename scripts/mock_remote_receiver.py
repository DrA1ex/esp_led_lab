#!/usr/bin/env python3
"""WebSocket audio receiver that answers like the ESP8266 firmware
(src/network/protocol/server/remote_audio_ws.cpp): hello_ack with
WIDTH x HEIGHT and capabilities (with "chroma": frames may carry the 12
pitch classes, byte 37 bit 0), sync_ack, clock_ack, config_ack, start_ack,
stop_ack, status and the lamp controls (power, brightness -> control_ack).
Use it to check the lab without a lamp.
Run: python3 scripts/mock_remote_receiver.py --port 8765 [--width 153 --height 1]
then connect the lab to 127.0.0.1:8765.
Requires: pip install websockets. Never flashes or configures an ESP device.
"""
import argparse
import json
import struct
import time
from websockets.sync.server import serve


EXT_CHROMA = 1  # byte 37: 12 chroma bytes (C..B, 255 = the strongest) follow the bands
NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def parse_frame(message):
    if len(message) < 38 or message[:4] != b'ELAF':
        raise ValueError('Invalid ELAF packet')
    version, kind, flags, count = struct.unpack_from('<BBBB', message, 4)
    if version != 1 or kind != 1 or count not in (16, 32, 64):
        raise ValueError('Unsupported audio version/type/band count')
    session, seq, when = struct.unpack_from('<III', message, 8)
    audio = struct.unpack_from('<6H', message, 20)
    onset, phase, bpm10, confidence, extensions = struct.unpack_from('<BBHBB', message, 32)
    if extensions & ~EXT_CHROMA or (extensions and ARGS.no_chroma):
        raise ValueError(f'Unknown extensions: {extensions}')
    if len(message) != 38 + 2 * count + (12 if extensions & EXT_CHROMA else 0):
        raise ValueError(f'Unexpected frame size: {len(message)}')
    bands = struct.unpack_from(f'<{count}H', message, 38)
    chroma = tuple(message[38 + 2 * count:]) if extensions & EXT_CHROMA else None
    if max(*audio, *bands) > 4096:
        raise ValueError('Out of range payload')
    return dict(session=session, sequence=seq, sender_timestamp=when, flags=flags,
                count=count, onset=onset, phase=phase, bpm10=bpm10,
                confidence=confidence, bands=bands, chroma=chroma)


ARGS = None
START = time.monotonic()
LAMP = dict(power=True, brightness=128)  # persists across connections, like the lamp's config


def millis():
    return int((time.monotonic() - START) * 1000) & 0xFFFFFFFF


def receiver(ws):
    frames = 0
    clock = False
    playing = False
    for message in ws:
        if isinstance(message, bytes):
            try:
                frame = parse_frame(message)
            except ValueError as err:
                print('bad frame:', err)
                continue
            frames += 1
            if frames % 50 == 1:
                chroma = frame['chroma']
                notes = (' notes=' + ' '.join(NOTES[i] for i in range(12) if chroma[i] >= 128)) if chroma else ''
                print(f'frame {frames}: session={frame["session"]} seq={frame["sequence"]} '
                      f'bands={frame["count"]} max={max(frame["bands"])}{notes}')
            continue
        try:
            msg = json.loads(message)
        except ValueError:
            ws.send(json.dumps(dict(type='error', reason='invalid_json')))
            continue
        op = msg.get('type')
        if op == 'hello':
            print('hello', msg)
            ws.send(json.dumps(dict(type='hello_ack', version=1, session=1, width=ARGS.width,
                                    height=ARGS.height, bands=32, band_counts=[16, 32, 64], fps=60,
                                    capabilities=['sync', 'clock', 'config', 'status', 'tuning', 'visualizations']
                                    + ([] if ARGS.no_control else ['control'])
                                    + ([] if ARGS.no_chroma else ['chroma']),
                                    visualizations=[] if ARGS.no_viz else list(range(12, 31)),
                                    **({} if ARGS.no_control else LAMP))))
        elif op == 'sync':
            t1 = millis()
            ws.send(json.dumps(dict(type='sync_ack', session=1, id=msg.get('id'), t0=msg.get('t0'),
                                    t1=t1, t2=millis())))
        elif op == 'clock':
            clock = True
            print('clock', msg)
            ws.send(json.dumps(dict(type='clock_ack', session=1)))
        elif op == 'config':
            # Lab clients send lab mode ids: firmware id + 1, 0 = Off; 13..31 are visualizations.
            effect = msg.get('audio_effect', 0)
            ok = (msg.get('input_min', 0) < msg.get('input_max', 255)
                  and 25 <= msg.get('input_curve', 100) <= 400
                  and (effect <= 12 or (not ARGS.no_viz and effect <= 31))
                  and msg.get('viz_color', 0) in (0, 1)
                  and all(0 <= msg.get(k, 0) <= 100 for k in ('viz_contrast', 'viz_decay', 'viz_motion', 'viz_blur')))
            print('config', msg)
            ws.send(json.dumps(dict(type='config_ack', session=1) if ok
                               else dict(type='error', reason='invalid_config')))
        elif op == 'start':
            playing = clock
            ws.send(json.dumps(dict(type='start_ack', session=1) if clock
                               else dict(type='error', reason='clock_not_set')))
        elif op == 'stop':
            playing = False
            ws.send(json.dumps(dict(type='stop_ack', session=1)))
        elif op == 'status':
            ws.send(json.dumps(dict(type='status', session=1, playing=playing, received=frames,
                                    received_frames=frames, dropped=0, buffer_occupancy=0,
                                    **({} if ARGS.no_control else LAMP))))
        elif op in ('power', 'brightness') and not ARGS.no_control:
            value = msg.get('on' if op == 'power' else 'value')
            if op == 'power' and isinstance(value, bool):
                LAMP['power'] = value
            elif op == 'brightness' and isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 255:
                LAMP['brightness'] = value
            else:
                ws.send(json.dumps(dict(type='error', reason='invalid_' + op)))
                continue
            print(op, value)
            ws.send(json.dumps(dict(type='control_ack', **LAMP)))
        else:
            ws.send(json.dumps(dict(type='error', reason='unknown_command')))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--width', type=int, default=16)
    ap.add_argument('--height', type=int, default=16)
    ap.add_argument('--no-viz', action='store_true', help='behave like firmware without visualizations')
    ap.add_argument('--no-control', action='store_true', help='behave like firmware without power / brightness')
    ap.add_argument('--no-chroma', action='store_true', help='behave like firmware without chroma (v1 frames only)')
    args = ARGS = ap.parse_args()
    print(f'Mock ESP receiver listening on ws://{args.host}:{args.port}/audio')
    with serve(receiver, args.host, args.port) as server:
        server.serve_forever()
