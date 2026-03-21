import React from 'react';

// Automatically generate 5 full octaves (C2 to B6) + ending C7
const generateKeys = (startOctave, endOctave) => {
  const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const keys = [];
  
  for (let oct = startOctave; oct <= endOctave; oct++) {
    notes.forEach(note => {
      keys.push({ 
        note: `${note}${oct}`, 
        type: note.includes('#') ? 'black' : 'white' 
      });
    });
  }
  keys.push({ note: `C${endOctave + 1}`, type: 'white' }); // The final C
  return keys;
};

const PIANO_KEYS = generateKeys(2, 6); // C2 to C7 (61 keys)

export function PianoKeyboard({ activeNotes, onPlayNote, onStopNote }) {
  const safeActiveNotes = activeNotes || [];

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      {PIANO_KEYS.map(({ note, type }) => {
        const isActive = safeActiveNotes.includes(note);
        const isWhite = type === 'white';
        const baseColor = isWhite ? 'white' : '#222'; 
        const activeColor = '#007bff'; 
        
        return (
          <div
            key={note}
            onMouseDown={() => onPlayNote(note)}
            onMouseUp={() => onStopNote(note)}
            onMouseLeave={() => onStopNote(note)} 
            style={{
              width: isWhite ? '40px' : '24px',
              height: isWhite ? '150px' : '90px',
              backgroundColor: isActive ? activeColor : baseColor,
              border: '1px solid #ccc',
              borderRadius: '0 0 4px 4px',
              margin: isWhite ? '0' : '0 -12px',
              zIndex: isWhite ? 1 : 2,
              position: 'relative',
              cursor: 'pointer',
              boxShadow: isActive ? 'inset 0 0 10px rgba(0,0,0,0.5)' : 'none',
              flexShrink: 0 // Prevents the keys from squishing!
            }}
          />
        );
      })}
    </div>
  );
}