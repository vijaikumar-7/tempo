import React, { useState, useEffect, useRef, useMemo } from 'react';
import * as Tone from 'tone'; // 🔥 NEW IMPORT: Explicitly import Tone
import { Midi } from '@tonejs/midi';
import { useMidi } from './hooks/useMidi';
import { startAudioContext, playNote, stopNote } from './lib/AudioEngine';
import { PianoKeyboard } from './components/PianoKeyboard';
import { MidiLoader } from './components/MidiLoader';
import { Waterfall } from './components/Waterfall';
import { Header } from './components/Header';
import { CoachChat } from './components/CoachChat';
import { ScoreDisplay } from './components/ScoreDisplay';
import { SkillGraph } from './components/SkillGraph';
import { ModeSelector } from './components/ModeSelector';
import { useStore } from './lib/store';
import { isInsForgeConfigured, saveSession } from './lib/insforgeClient';
import {
  buildExpectedSequenceFromSong,
  createMatcherState,
  detectSkippedNotes,
  evaluatePlayedNote,
  shouldCompletePhrase,
  finalizePhrase,
} from './lib/patternMatcher';
import { convertWebmToWav } from './lib/wavEncoder';
import './App.css';

const KEYBOARD_MAP = {
  a: 'C3', w: 'C#3', s: 'D3', e: 'D#3', d: 'E3', f: 'F3',
  t: 'F#3', g: 'G3', y: 'G#3', h: 'A3', u: 'A#3', j: 'B3',
  k: 'C4', o: 'C#4', l: 'D4', p: 'D#4', ';': 'E4', "'": 'F4',
  ']': 'F#4', '\\': 'G4',
};

const PIANO_KEYS_SET = new Set(Object.keys(KEYBOARD_MAP));

const normalizeMidiData = (parsedMidi) => {
  const flatToSharp = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };
  parsedMidi.tracks.forEach((track) => {
    track.notes.forEach((note) => {
      const match = note.name.match(/^([A-G](?:#|b)?)(-?\d+)$/);
      if (!match) return;
      const [, baseNote, octave] = match;
      if (flatToSharp[baseNote]) note.name = `${flatToSharp[baseNote]}${octave}`;
    });
  });
  return parsedMidi;
};

// 🔥 BULLETPROOF GLOBAL TIMELINE
let GLOBAL_TIMELINE = [];

function App() {
  const [localNotes, setLocalNotes] = useState({});
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [songLibrary, setSongLibrary] = useState([]);
  const [currentSongIndex, setCurrentSongIndex] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [isWaitMode, setIsWaitMode] = useState(false);
  const [expectedNotes, setExpectedNotes] = useState([]);
  const [matcherState, setMatcherState] = useState(createMatcherState());
  const [noteFeedback, setNoteFeedback] = useState({});
  const [lastPhraseSummary, setLastPhraseSummary] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);

  // 🥁 AI Backing Track State
  const [isRecording, setIsRecording] = useState(false);
  const [isGeneratingDrums, setIsGeneratingDrums] = useState(false);
  const [mixedTrackUrl, setMixedTrackUrl] = useState(null);

  const mode = useStore((s) => s.mode);
  const addCoachMessage = useStore((s) => s.addCoachMessage);
  const updateSkill = useStore((s) => s.updateSkill);
  const skills = useStore((s) => s.skills);

  const scrollWrapperRef = useRef(null);
  const exerciseStartRef = useRef(null);
  const lastPlayedAtRef = useRef(0);
  const phraseTimerRef = useRef(null);
  const wsRef = useRef(null);

  // 🥁 Refs for audio recording
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const activeKeysRef = useRef({});

  const targetSong = currentSongIndex !== null ? songLibrary[currentSongIndex]?.midi ?? null : null;
  const currentSongName = currentSongIndex !== null ? songLibrary[currentSongIndex]?.name ?? null : null;

  useEffect(() => {
    const checkWs = setInterval(() => {
      setWsConnected(wsRef.current?.readyState === WebSocket.OPEN);
    }, 2000);
    return () => clearInterval(checkWs);
  }, []);

  const resetMatcher = () => {
    setMatcherState(createMatcherState());
    setLastPhraseSummary(null);
    setNoteFeedback({});
    exerciseStartRef.current = null;
    lastPlayedAtRef.current = 0;
    GLOBAL_TIMELINE = []; 
    
    if (phraseTimerRef.current) {
      clearTimeout(phraseTimerRef.current);
      phraseTimerRef.current = null;
    }
  };

  const clearFeedbackAfterDelay = (note) => {
    window.setTimeout(() => {
      setNoteFeedback((prev) => { const next = { ...prev }; delete next[note]; return next; });
    }, 350);
  };

  const getPlaybackTimeSeconds = () => {
    if (!exerciseStartRef.current) return 0;
    return (performance.now() - exerciseStartRef.current) / 1000;
  };

  // ══════════════════════════════════════════════════════
  // 🎙️ AUDIO RECORDING & API LOGIC
  // ══════════════════════════════════════════════════════

  const startRecording = async () => {
    await initAudio(); 

    try {
      // 🔥 FIX 1: Hook into Tone's existing output stream explicitly
      const dest = Tone.getContext().rawContext.createMediaStreamDestination();
      Tone.getDestination().connect(dest);

      // 🔥 FIX 2: Ask for a format the browser fully supports
      let options = {};
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        options = { mimeType: 'audio/webm;codecs=opus' };
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        options = { mimeType: 'audio/mp4' }; 
      }

      mediaRecorderRef.current = new MediaRecorder(dest.stream, options);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorderRef.current.onstop = () => {
        const actualMimeType = mediaRecorderRef.current.mimeType || 'audio/webm';
        const audioBlob = new Blob(audioChunksRef.current, { type: actualMimeType });

        // 🔥 FIX 3: Check for tiny files (empty headers). 
        if (audioBlob.size < 1000) {
          alert("Recording failed: The audio file is empty. Make sure you play some notes!");
          setIsGeneratingDrums(false);
          return;
        }

        generateDrums(audioBlob);
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
      
      if (!isPlaying) setIsPlaying(true);

    } catch (err) {
      console.error("Failed to start recording:", err);
      alert("Could not start audio recording.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    setIsPlaying(false);
  };

  const generateDrums = async (audioBlob) => {
    setIsGeneratingDrums(true);
    setMixedTrackUrl(null); 

    try {
      // Convert browser recording to pure WAV
      const wavBlob = await convertWebmToWav(audioBlob);

      const formData = new FormData();
      formData.append('user_audio', wavBlob, 'user_performance.wav'); 

      const response = await fetch('http://localhost:8000/api/generate-backing-track', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error('Failed to generate backing track');

      const returnedBlob = await response.blob();
      const url = URL.createObjectURL(returnedBlob);
      
      setMixedTrackUrl(url); 
    } catch (error) {
      console.error("Error generating drums:", error);
      alert("Failed to generate AI drum track.");
    } finally {
      setIsGeneratingDrums(false);
    }
  };

  // ══════════════════════════════════════════════════════
  // CORE APP LOGIC
  // ══════════════════════════════════════════════════════

  const completePhraseIfNeeded = (stateToCheck) => {
    const now = performance.now();
    if (!shouldCompletePhrase(stateToCheck, lastPlayedAtRef.current, now)) return stateToCheck;
    
    const { state: nextState, phraseSummary } = finalizePhrase(stateToCheck);

    setTimeout(() => {
      setLastPhraseSummary(phraseSummary);

      if (phraseSummary.errors.length > 3) {
        const errTypes = phraseSummary.errors.map((e) => e.type).join(', ');
        addCoachMessage({
          role: 'system',
          content: `Phrase #${phraseSummary.phraseNumber}: ${phraseSummary.errors.length} errors (${errTypes}). Accuracy: ${Math.round(phraseSummary.sessionAccuracy * 100)}%`,
        });
      }

      if (phraseSummary.sessionAccuracy > 0.8) {
        updateSkill('quarter', Math.min(1, (skills.find((s) => s.id === 'quarter')?.mastery || 0) + 0.05));
      }
    }, 0);

    return nextState;
  };

  const handleMatchedNote = (note, velocity = 80, source = 'virtual') => {
    if (!expectedNotes.length) return;
    if (isWaitMode && !isPlaying) return;
    if (!exerciseStartRef.current) exerciseStartRef.current = performance.now();

    const playedTimeSeconds = getPlaybackTimeSeconds();

    let tempState = detectSkippedNotes({ state: matcherState, expectedNotes, playbackTimeSeconds: playedTimeSeconds, isWaitMode });
    const currentExpected = expectedNotes[tempState.expectedIndex];

    if (currentExpected) {
      const delta = Math.round((playedTimeSeconds - currentExpected.time) * 1000);
      GLOBAL_TIMELINE.push({
        expected: currentExpected.note,
        played: note,
        timingDeltaMs: delta
      });
    }

    setMatcherState((prevState) => {
      let workingState = detectSkippedNotes({ state: prevState, expectedNotes, playbackTimeSeconds: playedTimeSeconds, isWaitMode });
      const expected = expectedNotes[workingState.expectedIndex];
      
      const { state: evaluatedState, result } = evaluatePlayedNote({
        state: workingState, 
        expectedNote: expected, 
        playedNote: note, 
        playedTimeSeconds, 
        velocity,
        isWaitMode
      });

      setTimeout(() => {
        setNoteFeedback((prev) => ({
          ...prev,
          [note]: {
            type: result.feedbackType,
            label: expected ? `${result.feedbackType.toUpperCase()} — expected ${expected.note}` : `Played ${note}`,
          },
        }));
        clearFeedbackAfterDelay(note);
      }, 0);

      lastPlayedAtRef.current = performance.now();

      if (phraseTimerRef.current) clearTimeout(phraseTimerRef.current);
      phraseTimerRef.current = setTimeout(() => {
        setMatcherState((latestState) => completePhraseIfNeeded(latestState));
      }, 850);

      const maybeCompleted = completePhraseIfNeeded(evaluatedState);
      
      if (maybeCompleted.expectedIndex >= expectedNotes.length && maybeCompleted.expectedIndex === evaluatedState.expectedIndex) {
        return completePhraseIfNeeded(maybeCompleted);
      }
      
      return maybeCompleted;
    });
  };

  const { isReady: isMidiReady, activeNotes: midiNotes, error: midiError } = useMidi({
    onNoteEvent: (event) => {
      if (event.type === 'note_on') {
        playNote(event.note); 
        handleMatchedNote(event.note, event.velocity ?? 80, event.source || 'physical');
      } else if (event.type === 'note_off') {
        stopNote(event.note); 
      }
    },
  });

  useEffect(() => {
    if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
      const ws = new WebSocket('ws://localhost:8000/ws');
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => setWsConnected(false);
      ws.onerror = () => setWsConnected(false);
      
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        addCoachMessage(msg);
      };
      
      wsRef.current = ws;
    }
    return () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      if (PIANO_KEYS_SET.has(key)) {
        e.preventDefault();
        e.stopPropagation();
        const note = KEYBOARD_MAP[key];
        
        if (note && !activeKeysRef.current[note]) {
          activeKeysRef.current[note] = true;
          setLocalNotes((prev) => ({ ...prev, [note]: true }));
          playNote(note);
          handleMatchedNote(note, 80, 'keyboard');
        }
      }
    }
    function onKeyUp(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const key = e.key.toLowerCase();
      if (PIANO_KEYS_SET.has(key)) {
        e.preventDefault();
        const note = KEYBOARD_MAP[key];
        if (note) {
          activeKeysRef.current[note] = false;
          setLocalNotes((prev) => { const n = { ...prev }; delete n[note]; return n; });
          stopNote(note);
        }
      }
    }
    
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
    };
  }, []);

  useEffect(() => {
    if (scrollWrapperRef.current) {
      scrollWrapperRef.current.scrollLeft = 720 - window.innerWidth / 2;
    }
  }, []);

  useEffect(() => { return () => { if (phraseTimerRef.current) clearTimeout(phraseTimerRef.current); }; }, []);

  useEffect(() => {
    if (!targetSong) { setExpectedNotes([]); resetMatcher(); return; }
    setExpectedNotes(buildExpectedSequenceFromSong(targetSong));
    resetMatcher();
  }, [targetSong]);

  const initAudio = async () => {
    if (!audioEnabled) { await startAudioContext(); setAudioEnabled(true); }
  };

  const handleMidiLoaded = (songs) => {
    const cleaned = songs.map((s) => ({ ...s, midi: normalizeMidiData(s.midi), name: s.fileName.replace('.mid', '') }));
    setSongLibrary((prev) => [...prev, ...cleaned]);
    if (currentSongIndex === null && cleaned.length > 0) {
      setCurrentSongIndex(songLibrary.length);
    }
  };

  const allActiveNotes = useMemo(() => {
    return [...Object.keys(localNotes), ...Object.keys(midiNotes)];
  }, [localNotes, midiNotes]);

  const currentExpected = expectedNotes[matcherState.expectedIndex] || null;

  return (
    <div className="kf-app">
      <Header midiReady={isMidiReady} midiError={midiError} wsConnected={wsConnected} />

      <div className="kf-main">
        <div className="kf-play-area">
          <ScoreDisplay matcherState={matcherState} />

          <div className="kf-waterfall-wrapper" ref={scrollWrapperRef}>
            <div className="kf-waterfall-inner">
              <Waterfall
                song={targetSong}
                isPlaying={isPlaying}
                onReset={resetKey}
                audioEnabled={audioEnabled}
                activeNotes={allActiveNotes}
                isWaitMode={isWaitMode}
              />
              <PianoKeyboard
                activeNotes={allActiveNotes}
                noteFeedback={noteFeedback}
                onPlayNote={async (note) => {
                  await initAudio();
                  if (!activeKeysRef.current[note]) {
                    activeKeysRef.current[note] = true;
                    setLocalNotes((prev) => ({ ...prev, [note]: true }));
                    playNote(note);
                    handleMatchedNote(note, 80, 'virtual');
                  }
                }}
                onStopNote={(note) => {
                  if (activeKeysRef.current[note]) {
                    activeKeysRef.current[note] = false;
                    setLocalNotes((prev) => { const n = { ...prev }; delete n[note]; return n; });
                    stopNote(note);
                  }
                }}
              />
            </div>
          </div>

          <div className="kf-controls">
            <div className="kf-controls-row">
              <button className={`kf-btn ${isPlaying ? 'kf-btn-warn' : 'kf-btn-accent'}`}
                onClick={async () => { await initAudio(); setIsPlaying((p) => !p); }}>
                {isPlaying ? '⏸ Pause' : '▶ Play'}
              </button>
              
              <button className={`kf-btn ${isWaitMode ? 'kf-btn-purple' : 'kf-btn-outline'}`}
                onClick={() => setIsWaitMode((p) => !p)}>
                Wait: {isWaitMode ? 'ON' : 'OFF'}
              </button>
              
              <button className="kf-btn kf-btn-outline"
                onClick={() => { setResetKey((p) => p + 1); setIsPlaying(false); stopRecording(); resetMatcher(); }}>
                ⏪ Rewind
              </button>

              <button 
                className={`kf-btn ${isRecording ? 'kf-btn-warn' : 'kf-btn-outline'}`}
                onClick={isRecording ? stopRecording : startRecording}
                style={{ marginLeft: 'auto' }}
              >
                {isRecording ? '⏹ Stop Recording' : '⏺ Record with AI Drums'}
              </button>
            </div>

            {isGeneratingDrums && (
              <div className="mt-4 p-4 rounded-lg bg-blue-50 text-blue-800" style={{ animation: 'pulse 2s infinite', border: '1px solid #bfdbfe' }}>
                <p className="font-semibold">🥁 Analyzing your tempo & generating AI drum beat...</p>
              </div>
            )}

            {mixedTrackUrl && !isGeneratingDrums && (
              <div className="mt-4 p-4 rounded-lg bg-gray-50 border border-gray-200 shadow-sm">
                <h3 className="font-bold mb-2 text-gray-800">Listen with AI Backing Track!</h3>
                <audio controls src={mixedTrackUrl} className="w-full" />
              </div>
            )}

            {currentSongName && (
              <div className="kf-now-playing">
                <span className="kf-np-label">Now playing:</span>
                <span className="kf-np-title">{currentSongName}</span>
                {currentExpected && (
                  <span className="kf-np-next">Next: <strong>{currentExpected.note}</strong></span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="kf-sidebar">
          <ModeSelector />

          <div className="kf-song-library">
            <h4 className="kf-section-title">Song Library</h4>
            {songLibrary.length === 0 ? (
              <p className="kf-empty-hint">Upload MIDI files below to get started</p>
            ) : (
              <div className="kf-song-list">
                {songLibrary.map((song, idx) => (
                  <button
                    key={song.id || idx}
                    className={`kf-song-item ${currentSongIndex === idx ? 'active' : ''}`}
                    onClick={async () => { await initAudio(); setCurrentSongIndex(idx); setIsPlaying(false); resetMatcher(); }}
                  >
                    <span className="kf-song-name">{song.name || song.fileName}</span>
                    <span className="kf-song-meta">
                      {song.midi?.tracks?.find((t) => t.notes.length)?.notes.length || 0} notes
                    </span>
                  </button>
                ))}
              </div>
            )}
            <MidiLoader onMidiLoaded={handleMidiLoaded} />
          </div>

          <CoachChat
            wsRef={wsRef}
            matcherState={matcherState}
            songName={currentSongName}
            mode={mode}
            fullTimeline={GLOBAL_TIMELINE} 
          />

          <SkillGraph />

          <div className="kf-integrations">
            <span className={`kf-integration-badge ${isInsForgeConfigured() ? 'active' : ''}`}>
              {isInsForgeConfigured() ? '✓ InsForge' : '○ InsForge'}
            </span>
            <span className={`kf-integration-badge ${wsConnected ? 'active' : ''}`}>
              {wsConnected ? '✓ AI Coach' : '○ AI Coach'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;