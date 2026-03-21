import { useEffect, useState, useRef } from 'react';
import { WebMidi } from 'webmidi';
import { playNote, stopNote } from './AudioEngine';

export function useMidi({ onNoteEvent } = {}) {
  const [isReady, setIsReady] = useState(false);
  const [activeNotes, setActiveNotes] = useState({});
  const [error, setError] = useState(null);
  const wsRef = useRef(null);

  const emitMidiEvent = (type, note, velocity = null, source = 'virtual') => {
    const payload = {
      type,
      note,
      velocity,
      source,
      time: performance.now(),
    };

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }

    if (onNoteEvent) {
      onNoteEvent(payload);
    }
  };

  useEffect(() => {
    wsRef.current = new WebSocket('ws://localhost:8000/ws');

    wsRef.current.onopen = () => {
      console.log('🔌 Connected to Python Server!');
    };

    wsRef.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.action === 'processed_note') {
        console.log(
          `🎹 Python says: You played ${data.note} for ${data.duration_seconds}s!`
        );
      }
    };

    wsRef.current.onerror = (err) => {
      console.error('WebSocket error:', err);
    };

    wsRef.current.onclose = () => {
      console.log('🔌 Python WebSocket disconnected');
    };

    const attachListeners = (input) => {
      if (input.hasListener('noteon')) return;

      console.log(`✅ Connected to physical keyboard: ${input.name}`);

      input.addListener('noteon', (e) => {
        const noteName = e.note.identifier;
        const velocity = Math.round((e.rawVelocity ?? e.velocity ?? 0.7) * 127);

        setActiveNotes((prev) => ({ ...prev, [noteName]: true }));
        playNote(noteName);
        emitMidiEvent('note_on', noteName, velocity, 'physical');
      });

      input.addListener('noteoff', (e) => {
        const noteName = e.note.identifier;
        const velocity = Math.round((e.rawVelocity ?? e.velocity ?? 0) * 127);

        setActiveNotes((prev) => {
          const next = { ...prev };
          delete next[noteName];
          return next;
        });

        stopNote(noteName);
        emitMidiEvent('note_off', noteName, velocity, 'physical');
      });
    };

    WebMidi.enable()
      .then(() => {
        setIsReady(true);

        WebMidi.inputs.forEach(attachListeners);

        WebMidi.addListener('connected', (e) => {
          if (e.port.type === 'input') {
            attachListeners(e.port);
          }
        });

        WebMidi.addListener('disconnected', (e) => {
          if (e.port.type === 'input') {
            console.log(`❌ MIDI disconnected: ${e.port.name}`);
          }
        });
      })
      .catch((err) => {
        console.error('WebMidi could not be enabled.', err);
        setError('Please allow MIDI access.');
      });

    return () => {
      try {
        WebMidi.disable();
      } catch (err) {
        console.warn('WebMidi disable warning:', err);
      }

      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [onNoteEvent]);

  return {
    isReady,
    activeNotes,
    error,
    emitMidiEvent,
  };
}