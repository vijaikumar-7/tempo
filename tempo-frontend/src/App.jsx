import React, { useState, useEffect, useRef } from 'react';
import { useMidi } from './useMidi';
import { playNote, stopNote, startAudioContext } from './AudioEngine';
import { PianoKeyboard } from './PianoKeyboard';
import { MidiLoader } from './MidiLoader'; 
import { Waterfall } from './Waterfall';

const KEYBOARD_MAP = {
  'a': 'C3', 'w': 'C#3', 's': 'D3', 'e': 'D#3', 'd': 'E3',
  'f': 'F3', 't': 'F#3', 'g': 'G3', 'y': 'G#3', 'h': 'A3',
  'u': 'A#3', 'j': 'B3', 
  'k': 'C4', 'o': 'C#4', 'l': 'D4', 'p': 'D#4', ';': 'E4',
  "'": 'F4', ']': 'F#4', '\\': 'G4' 
};

function App() {
  // We grab emitMidiEvent here to send computer/mouse inputs to Python!
  const { isReady: isMidiReady, activeNotes: midiNotes, error: midiError, emitMidiEvent } = useMidi();
  
  const [localNotes, setLocalNotes] = useState({});
  const [audioEnabled, setAudioEnabled] = useState(false);
  
  const [targetSong, setTargetSong] = useState(null); 
  const [isPlaying, setIsPlaying] = useState(false);
  const [resetKey, setResetKey] = useState(0); 

  // Auto-scroll logic so the keyboard is centered on load
  const scrollWrapperRef = useRef(null);
  useEffect(() => {
    if (scrollWrapperRef.current) {
      // 1440px is our piano width. We scroll so the center is in the middle of the screen.
      const scrollTarget = 720 - (window.innerWidth / 2);
      scrollWrapperRef.current.scrollLeft = scrollTarget;
    }
  }, []);

  const handleEnableAudio = async () => {
    await startAudioContext();
    setAudioEnabled(true);
  };

  useEffect(() => {
    if (!audioEnabled) return;

    const handleKeyDown = (e) => {
      if (e.repeat) return; 
      const note = KEYBOARD_MAP[e.key.toLowerCase()];
      if (note && !localNotes[note]) {
        playNote(note);
        setLocalNotes((prev) => ({ ...prev, [note]: true }));
        if (emitMidiEvent) emitMidiEvent("note_on", note); // Send to Python
      }
    };

    const handleKeyUp = (e) => {
      const note = KEYBOARD_MAP[e.key.toLowerCase()];
      if (note) {
        stopNote(note);
        setLocalNotes((prev) => {
          const newNotes = { ...prev };
          delete newNotes[note];
          return newNotes;
        });
        if (emitMidiEvent) emitMidiEvent("note_off", note); // Send to Python
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [audioEnabled, localNotes, emitMidiEvent]);

  const allActiveNotes = Array.from(
    new Set([...Object.keys(midiNotes || {}), ...Object.keys(localNotes || {})])
  );

  return (
    <div style={{ width: '100vw', margin: 0, padding: 0, overflowX: 'hidden', fontFamily: 'sans-serif', backgroundColor: '#fafafa', minHeight: '100vh' }}>
      
      {/* Header UI Area */}
      <div style={{ padding: '2rem', textAlign: 'center', maxWidth: '800px', margin: '0 auto' }}>
        <h1>🎹 Tempo</h1>
        <p style={{ fontSize: '1.2rem', color: '#555' }}>Your AI Music Tutor</p>
        
        {!audioEnabled ? (
          <button 
            onClick={handleEnableAudio}
            style={{ padding: '1rem 2rem', fontSize: '1.2rem', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', marginBottom: '1rem' }}
          >
            🔊 Enable Audio to Start
          </button>
        ) : (
          <div style={{ padding: '1rem', backgroundColor: '#e9ecef', borderRadius: '8px', marginBottom: '1rem' }}>
            <p style={{ color: 'green', fontWeight: 'bold', margin: '0' }}>🔊 Audio Engine & WebSocket Active</p>
          </div>
        )}

        {!targetSong ? (
          <MidiLoader onMidiLoaded={(midiData) => {
            setTargetSong(midiData);
            setResetKey(prev => prev + 1); 
            setIsPlaying(false);
          }} />
        ) : (
          <div style={{ padding: '1rem', backgroundColor: '#d4edda', borderRadius: '8px', marginTop: '1rem', marginBottom: '1rem', border: '1px solid #c3e6cb' }}>
            <p style={{ color: '#155724', fontWeight: 'bold', margin: '0 0 0.5rem 0' }}>
              ✅ Song Loaded: {targetSong.name || "Custom MIDI Track"}
            </p>
            
            <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginTop: '1rem' }}>
              <button 
                onClick={() => setIsPlaying(!isPlaying)}
                style={{ padding: '0.5rem 1.5rem', fontSize: '1.2rem', backgroundColor: isPlaying ? '#ffc107' : '#007bff', color: isPlaying ? 'black' : 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
              >
                {isPlaying ? '⏸ Pause' : '▶️ Play Sheet Music'}
              </button>
              <button 
                onClick={() => { setResetKey(prev => prev + 1); setIsPlaying(false); }}
                style={{ padding: '0.5rem 1rem', cursor: 'pointer', borderRadius: '4px', border: '1px solid #999', backgroundColor: '#eee' }}
              >
                ⏪ Rewind
              </button>
              <button 
                onClick={() => { setTargetSong(null); setIsPlaying(false); }}
                style={{ padding: '0.5rem 1rem', cursor: 'pointer', borderRadius: '4px', border: '1px solid #ccc', backgroundColor: 'white' }}
              >
                Load Different Song
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Full Width Piano Area */}
      <div 
        ref={scrollWrapperRef}
        style={{ 
          width: '100%', 
          overflowX: 'auto', 
          display: 'flex', 
          paddingBottom: '2rem'
        }}
      >
        <div style={{ margin: '0 auto', display: 'inline-flex', flexDirection: 'column' }}>
          <Waterfall song={targetSong} isPlaying={isPlaying} onReset={resetKey} audioEnabled={audioEnabled} />
          
          <PianoKeyboard 
            activeNotes={allActiveNotes} 
            onPlayNote={(note) => {
              if (audioEnabled) playNote(note);
              setLocalNotes(prev => ({ ...prev, [note]: true }));
              if (emitMidiEvent) emitMidiEvent("note_on", note); // Send to Python
            }}
            onStopNote={(note) => {
              if (audioEnabled) stopNote(note);
              setLocalNotes(prev => {
                const newNotes = { ...prev };
                delete newNotes[note];
                return newNotes;
              });
              if (emitMidiEvent) emitMidiEvent("note_off", note); // Send to Python
            }}
          />
        </div>
      </div>
      
    </div>
  );
}

export default App;