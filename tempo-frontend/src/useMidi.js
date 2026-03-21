import { useEffect, useState } from 'react';
import { WebMidi } from 'webmidi';
import { playNote, stopNote } from './AudioEngine'; 

export function useMidi() {
  const [isReady, setIsReady] = useState(false);
  const [activeNotes, setActiveNotes] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => {
    // We create a helper function to attach listeners so we can reuse it
    const attachListeners = (input) => {
      // Prevent attaching multiple times to the same keyboard
      if (input.hasListener("noteon")) return; 
      
      console.log(`✅ Connected to physical keyboard: ${input.name}`);

      input.addListener("noteon", (e) => {
        const noteName = e.note.identifier;
        setActiveNotes((prev) => ({ ...prev, [noteName]: true }));
        playNote(noteName); 
      });

      input.addListener("noteoff", (e) => {
        const noteName = e.note.identifier;
        setActiveNotes((prev) => {
          const newNotes = { ...prev };
          delete newNotes[noteName];
          return newNotes;
        });
        stopNote(noteName); 
      });
    };

    WebMidi.enable()
      .then(() => {
        setIsReady(true);
        console.log("WebMidi enabled for Tempo! Looking for devices...");

        // 1. Check devices that are already awake and connected
        WebMidi.inputs.forEach(attachListeners);

        // 2. Listen for devices that are plugged in (or wake up) AFTER the page loads
        WebMidi.addListener("connected", (e) => {
          if (e.port.type === "input") {
            console.log(`🔌 New device detected: ${e.port.name}`);
            attachListeners(e.port);
          }
        });

        WebMidi.addListener("disconnected", (e) => {
          if (e.port.type === "input") {
            console.log(`❌ Device disconnected: ${e.port.name}`);
          }
        });
      })
      .catch((err) => {
        console.error("WebMidi could not be enabled.", err);
        setError("Please allow MIDI access in your browser to use Tempo.");
      });

    return () => {
      WebMidi.disable();
    };
  }, []);

  return { isReady, activeNotes, error };
}