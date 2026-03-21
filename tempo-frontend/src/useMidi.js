import { useEffect, useState, useRef } from 'react';
import { WebMidi } from 'webmidi';
import { playNote, stopNote } from './AudioEngine'; 

export function useMidi() {
  const [isReady, setIsReady] = useState(false);
  const [activeNotes, setActiveNotes] = useState({});
  const [error, setError] = useState(null);
  const wsRef = useRef(null);

  // 1. Create a reusable helper function to send data to Python
  const emitMidiEvent = (type, note) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: type,
        note: note,
        time: performance.now()
      }));
    }
  };

  useEffect(() => {
    wsRef.current = new WebSocket('ws://localhost:8000/ws');
    wsRef.current.onopen = () => console.log("🔌 Connected to Python Server!");
    wsRef.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.action === "processed_note") {
        console.log(`🎹 Python says: You played ${data.note} for ${data.duration_seconds}s!`);
      }
    };

    const attachListeners = (input) => {
      if (input.hasListener("noteon")) return; 
      console.log(`✅ Connected to physical keyboard: ${input.name}`);

      input.addListener("noteon", (e) => {
        const noteName = e.note.identifier;
        setActiveNotes((prev) => ({ ...prev, [noteName]: true }));
        playNote(noteName); 
        emitMidiEvent("note_on", noteName); // Use the helper for physical keys
      });

      input.addListener("noteoff", (e) => {
        const noteName = e.note.identifier;
        setActiveNotes((prev) => {
          const newNotes = { ...prev };
          delete newNotes[noteName];
          return newNotes;
        });
        stopNote(noteName); 
        emitMidiEvent("note_off", noteName); // Use the helper for physical keys
      });
    };

    WebMidi.enable()
      .then(() => {
        setIsReady(true);
        WebMidi.inputs.forEach(attachListeners);
        WebMidi.addListener("connected", (e) => {
          if (e.port.type === "input") attachListeners(e.port);
        });
      })
      .catch((err) => {
        console.error("WebMidi could not be enabled.", err);
        setError("Please allow MIDI access.");
      });

    return () => {
      WebMidi.disable();
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // 2. Export emitMidiEvent so App.jsx can use it!
  return { isReady, activeNotes, error, emitMidiEvent }; 
}