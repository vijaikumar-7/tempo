import React, { useState } from 'react';
import { Midi } from '@tonejs/midi';

export function MidiLoader({ onMidiLoaded }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setLoading(true);
    setError(null);

    try {
      // Read the file as an ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();
      
      // Parse the MIDI data using @tonejs/midi
      const parsedMidi = new Midi(arrayBuffer);
      
      console.log("Parsed MIDI Data:", parsedMidi);
      
      // Send the parsed data back to the main App
      onMidiLoaded(parsedMidi);
      setLoading(false);
    } catch (err) {
      console.error("Error parsing MIDI file:", err);
      setError("Could not parse this MIDI file. Please try another one.");
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '1.5rem', backgroundColor: '#fff', border: '2px dashed #ccc', borderRadius: '8px', marginTop: '2rem' }}>
      <h3>📄 Load Sheet Music (.mid)</h3>
      <p style={{ color: '#666', marginBottom: '1rem' }}>Upload a MIDI file to serve as the "Gold Standard" for your practice session.</p>
      
      <input 
        type="file" 
        accept="audio/midi, .mid" 
        onChange={handleFileUpload}
        style={{ display: 'block', margin: '0 auto' }}
      />

      {loading && <p style={{ color: '#007bff', fontWeight: 'bold', marginTop: '1rem' }}>Parsing MIDI file...</p>}
      {error && <p style={{ color: 'red', fontWeight: 'bold', marginTop: '1rem' }}>{error}</p>}
    </div>
  );
}