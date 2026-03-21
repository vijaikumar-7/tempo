import React, { useEffect, useRef } from 'react';
import { playNote, stopNote } from './AudioEngine';

const generateNotePositions = (startOctave, endOctave) => {
  const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const positions = {};
  let currentLeft = 0;

  for (let oct = startOctave; oct <= endOctave; oct++) {
    notes.forEach(note => {
      const isBlack = note.includes('#');
      if (isBlack) {
        positions[`${note}${oct}`] = { left: currentLeft - 12, width: 24, color: '#00f2fe' };
      } else {
        positions[`${note}${oct}`] = { left: currentLeft, width: 40, color: '#4facfe' };
        currentLeft += 40;
      }
    });
  }
  positions[`C${endOctave + 1}`] = { left: currentLeft, width: 40, color: '#4facfe' };
  currentLeft += 40;

  return { positions, totalWidth: currentLeft };
};

const { positions: NOTE_POSITIONS, totalWidth: WATERFALL_WIDTH } = generateNotePositions(2, 6);

const PIXELS_PER_SECOND = 150; 
const WATERFALL_HEIGHT = 400; 

export function Waterfall({ song, isPlaying, onReset, audioEnabled }) {
  const canvasRef = useRef(null);
  const timeRef = useRef(0);
  const lastFrameTimeRef = useRef(performance.now());
  const requestRef = useRef();
  
  // Track which notes are currently making sound
  const playingNotesRef = useRef(new Set());

  // Extract notes once
  const track = song?.tracks.find(t => t.notes.length > 0);
  const notes = track ? track.notes : [];

  // Stop all active audio if the user clicks pause, rewind, or changes songs
  const stopAllActiveNotes = () => {
    playingNotesRef.current.forEach(index => {
      const note = notes[index];
      if (note) stopNote(note.name);
    });
    playingNotesRef.current.clear();
  };

  // Handle Rewind / New Song
  useEffect(() => {
    timeRef.current = 0;
    lastFrameTimeRef.current = performance.now();
    stopAllActiveNotes();
  }, [song, onReset]);

  // Handle Pausing
  useEffect(() => {
    if (!isPlaying) stopAllActiveNotes();
  }, [isPlaying]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    const draw = (now) => {
      if (isPlaying) {
        const deltaSeconds = (now - lastFrameTimeRef.current) / 1000;
        timeRef.current += deltaSeconds;
      }
      lastFrameTimeRef.current = now;

      ctx.clearRect(0, 0, WATERFALL_WIDTH, WATERFALL_HEIGHT);
      ctx.fillStyle = '#1a1a1a'; 
      ctx.fillRect(0, 0, WATERFALL_WIDTH, WATERFALL_HEIGHT);

      notes.forEach((note, index) => {
        const pos = NOTE_POSITIONS[note.name];
        if (!pos) return;

        const bottomY = (note.time - timeRef.current) * PIXELS_PER_SECOND;
        const noteHeight = note.duration * PIXELS_PER_SECOND;

        // --- AUDIO ENGINE TRIGGER ---
        if (audioEnabled && isPlaying) {
          const isNoteActive = timeRef.current >= note.time && timeRef.current < (note.time + note.duration);
          
          if (isNoteActive && !playingNotesRef.current.has(index)) {
            playingNotesRef.current.add(index);
            playNote(note.name);
          } else if (!isNoteActive && playingNotesRef.current.has(index)) {
            playingNotesRef.current.delete(index);
            stopNote(note.name);
          }
        }

        // --- VISUAL DRAWING ---
        if (bottomY <= WATERFALL_HEIGHT && bottomY + noteHeight >= 0) {
          ctx.fillStyle = pos.color;
          const drawY = WATERFALL_HEIGHT - bottomY - noteHeight;
          
          ctx.fillRect(pos.left, drawY, pos.width, noteHeight);
          ctx.strokeStyle = 'rgba(0,0,0,0.8)';
          ctx.lineWidth = 2;
          ctx.strokeRect(pos.left, drawY, pos.width, noteHeight);
        }
      });

      requestRef.current = requestAnimationFrame(draw);
    };

    requestRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(requestRef.current);
  }, [song, isPlaying, audioEnabled, notes]);

  return (
    <canvas 
      ref={canvasRef}
      width={WATERFALL_WIDTH}
      height={WATERFALL_HEIGHT}
      style={{ 
        display: 'block', 
        border: '2px solid #333',
        borderBottom: 'none',
        borderRadius: '8px 8px 0 0',
        backgroundColor: '#1a1a1a'
      }}
    />
  );
}