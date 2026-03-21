import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Midi } from '@tonejs/midi';
import { useMidi } from './useMidi';
import { playNote, stopNote, startAudioContext } from './AudioEngine';
import { PianoKeyboard } from './PianoKeyboard';
import { MidiLoader } from './MidiLoader';
import { Waterfall } from './Waterfall';
import {
  buildExpectedSequenceFromSong,
  createMatcherState,
  detectSkippedNotes,
  evaluatePlayedNote,
  shouldCompletePhrase,
  finalizePhrase,
} from './patternMatcher';

const KEYBOARD_MAP = {
  a: 'C3',
  w: 'C#3',
  s: 'D3',
  e: 'D#3',
  d: 'E3',
  f: 'F3',
  t: 'F#3',
  g: 'G3',
  y: 'G#3',
  h: 'A3',
  u: 'A#3',
  j: 'B3',
  k: 'C4',
  o: 'C#4',
  l: 'D4',
  p: 'D#4',
  ';': 'E4',
  "'": 'F4',
  ']': 'F#4',
  '\\': 'G4',
};

const normalizeMidiData = (parsedMidi) => {
  const flatToSharp = {
    Db: 'C#',
    Eb: 'D#',
    Gb: 'F#',
    Ab: 'G#',
    Bb: 'A#',
  };

  parsedMidi.tracks.forEach((track) => {
    track.notes.forEach((note) => {
      const match = note.name.match(/^([A-G](?:#|b)?)(-?\d+)$/);
      if (!match) return;

      const [, baseNote, octave] = match;
      if (flatToSharp[baseNote]) {
        note.name = `${flatToSharp[baseNote]}${octave}`;
      }
    });
  });

  return parsedMidi;
};

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
  const [feedbackLog, setFeedbackLog] = useState([]);
  const [showDebugPanel, setShowDebugPanel] = useState(false);

  const scrollWrapperRef = useRef(null);
  const exerciseStartRef = useRef(null);
  const lastPlayedAtRef = useRef(0);
  const phraseTimerRef = useRef(null);

  const targetSong =
    currentSongIndex !== null ? songLibrary[currentSongIndex]?.midi ?? null : null;

  const currentSongName =
    currentSongIndex !== null ? songLibrary[currentSongIndex]?.name ?? null : null;

  const resetMatcher = () => {
    setMatcherState(createMatcherState());
    setLastPhraseSummary(null);
    setNoteFeedback({});
    exerciseStartRef.current = null;
    lastPlayedAtRef.current = 0;

    if (phraseTimerRef.current) {
      clearTimeout(phraseTimerRef.current);
      phraseTimerRef.current = null;
    }
  };

  const clearFeedbackAfterDelay = (note) => {
    window.setTimeout(() => {
      setNoteFeedback((prev) => {
        const next = { ...prev };
        delete next[note];
        return next;
      });
    }, 350);
  };

  const getPlaybackTimeSeconds = () => {
    if (!exerciseStartRef.current) return 0;
    return (performance.now() - exerciseStartRef.current) / 1000;
  };

  const completePhraseIfNeeded = (stateToCheck) => {
    const now = performance.now();

    if (!shouldCompletePhrase(stateToCheck, lastPlayedAtRef.current, now)) {
      return stateToCheck;
    }

    const { state: nextState, phraseSummary } = finalizePhrase(stateToCheck);
    setMatcherState(nextState);
    setLastPhraseSummary(phraseSummary);
    setFeedbackLog((prev) => [phraseSummary, ...prev].slice(0, 10));
    console.log('Phrase complete:', phraseSummary);

    return nextState;
  };

  const handleMatchedNote = (note, velocity = 80, source = 'virtual') => {
    if (!expectedNotes.length) return;
    if (isWaitMode && !isPlaying) return;

    if (!exerciseStartRef.current) {
      exerciseStartRef.current = performance.now();
    }

    const playedTimeSeconds = getPlaybackTimeSeconds();

    setMatcherState((prevState) => {
      let workingState = detectSkippedNotes({
        state: prevState,
        expectedNotes,
        playbackTimeSeconds: playedTimeSeconds,
      });

      const expected = expectedNotes[workingState.expectedIndex];

      const { state: evaluatedState, result } = evaluatePlayedNote({
        state: workingState,
        expectedNote: expected,
        playedNote: note,
        playedTimeSeconds,
        velocity,
      });

      setNoteFeedback((prev) => ({
        ...prev,
        [note]: {
          type: result.feedbackType,
          label: expected
            ? `${result.feedbackType.toUpperCase()} — expected ${expected.note}`
            : `Played ${note}`,
        },
      }));
      clearFeedbackAfterDelay(note);

      lastPlayedAtRef.current = performance.now();

      if (phraseTimerRef.current) {
        clearTimeout(phraseTimerRef.current);
      }

      phraseTimerRef.current = setTimeout(() => {
        setMatcherState((latestState) => completePhraseIfNeeded(latestState));
      }, 850);

      const maybeCompleted = completePhraseIfNeeded(evaluatedState);

      if (maybeCompleted.expectedIndex >= expectedNotes.length) {
        const finalState = completePhraseIfNeeded(maybeCompleted);
        console.log(`Exercise complete via ${source}`);
        return finalState;
      }

      return maybeCompleted;
    });
  };

  const {
    isReady: isMidiReady,
    activeNotes: midiNotes,
    error: midiError,
    emitMidiEvent,
  } = useMidi({
    onNoteEvent: (event) => {
      if (event.type === 'note_on') {
        handleMatchedNote(
          event.note,
          event.velocity ?? 80,
          event.source || 'physical'
        );
      }
    },
  });

  useEffect(() => {
    if (scrollWrapperRef.current) {
      const scrollTarget = 720 - window.innerWidth / 2;
      scrollWrapperRef.current.scrollLeft = scrollTarget;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (phraseTimerRef.current) {
        clearTimeout(phraseTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!targetSong) {
      setExpectedNotes([]);
      resetMatcher();
      return;
    }

    const nextExpected = buildExpectedSequenceFromSong(targetSong);
    setExpectedNotes(nextExpected);
    resetMatcher();
  }, [targetSong]);

  const initAudio = async () => {
    if (!audioEnabled) {
      await startAudioContext();
      setAudioEnabled(true);
    }
  };

  const loadSampleSong = async () => {
    try {
      await initAudio();

      const response = await fetch('/Happy Birthday MIDI.mid');
      if (!response.ok) {
        throw new Error("Could not find 'Happy Birthday MIDI.mid' in the public folder.");
      }

      const arrayBuffer = await response.arrayBuffer();
      const midiData = new Midi(arrayBuffer);
      const cleanedMidi = normalizeMidiData(midiData);

      const sampleSong = {
        id: 'sample-happy-birthday',
        name: cleanedMidi.name || 'Happy Birthday',
        midi: cleanedMidi,
      };

      setSongLibrary((prev) => {
        const withoutSample = prev.filter((song) => song.id !== sampleSong.id);
        const updated = [sampleSong, ...withoutSample];
        return updated;
      });

      setCurrentSongIndex(0);
      setResetKey((prev) => prev + 1);
      setIsPlaying(false);
      resetMatcher();
    } catch (error) {
      console.error('Error loading sample song:', error);
      alert("Make sure 'Happy Birthday MIDI.mid' is inside your public folder.");
    }
  };

  useEffect(() => {
    const handleBlur = () => {
      Object.keys(localNotes).forEach((note) => {
        stopNote(note);
        emitMidiEvent?.('note_off', note, 0, 'computer_keyboard');
      });
      setLocalNotes({});
    };

    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, [localNotes, emitMidiEvent]);

  useEffect(() => {
    const handleKeyDown = async (e) => {
      if (e.repeat) return;

      if (!audioEnabled) {
        await initAudio();
      }

      const note = KEYBOARD_MAP[e.key.toLowerCase()];
      if (note && !localNotes[note]) {
        playNote(note);
        setLocalNotes((prev) => ({ ...prev, [note]: true }));
        emitMidiEvent?.('note_on', note, 80, 'computer_keyboard');
      }
    };

    const handleKeyUp = (e) => {
      const note = KEYBOARD_MAP[e.key.toLowerCase()];
      if (note) {
        stopNote(note);
        setLocalNotes((prev) => {
          const next = { ...prev };
          delete next[note];
          return next;
        });
        emitMidiEvent?.('note_off', note, 0, 'computer_keyboard');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [audioEnabled, localNotes, emitMidiEvent]);

  const allActiveNotes = useMemo(
    () =>
      Array.from(
        new Set([...Object.keys(midiNotes || {}), ...Object.keys(localNotes || {})])
      ),
    [midiNotes, localNotes]
  );

  const currentExpected = expectedNotes[matcherState.expectedIndex] || null;

  const accuracyPercent =
    matcherState.sessionStats.totalNotes > 0
      ? Math.round(
          (matcherState.sessionStats.correctNotes /
            matcherState.sessionStats.totalNotes) *
            100
        )
      : 100;

  return (
    <div
      style={{
        width: '100vw',
        margin: 0,
        padding: 0,
        overflowX: 'hidden',
        fontFamily: 'sans-serif',
        backgroundColor: '#fafafa',
        minHeight: '100vh',
      }}
    >
      <div
        style={{
          padding: '2rem',
          textAlign: 'center',
          maxWidth: '1100px',
          margin: '0 auto',
        }}
      >
        <h1>🎹 Tempo</h1>
        <p style={{ fontSize: '1.2rem', color: '#555' }}>Your AI Music Tutor</p>

        {audioEnabled && (
          <div
            style={{
              padding: '0.8rem 1rem',
              backgroundColor: '#e9ecef',
              borderRadius: '8px',
              marginBottom: '1rem',
            }}
          >
            <strong style={{ color: 'green' }}>🔊 Audio Engine Active</strong>
            <div style={{ marginTop: '0.4rem', color: '#555' }}>
              MIDI: {isMidiReady ? 'Connected / Ready' : 'Waiting'}
              {midiError ? ` — ${midiError}` : ''}
            </div>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '1rem',
            flexWrap: 'wrap',
            marginBottom: '1rem',
          }}
        >
          <button
            onClick={loadSampleSong}
            style={{
              padding: '1rem 2rem',
              fontSize: '1.05rem',
              backgroundColor: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
            }}
          >
            Load Sample: Happy Birthday
          </button>
        </div>

        <MidiLoader
          onMidiLoaded={async (songs) => {
            await initAudio();

            const cleanedSongs = songs.map((song) => {
              const cleanedMidi = normalizeMidiData(song.midi);

              return {
                ...song,
                name: cleanedMidi.name || song.fileName.replace(/\.mid$/i, ''),
                midi: cleanedMidi,
              };
            });

            setSongLibrary((prev) => {
              const existingIds = new Set(prev.map((song) => song.id));
              const uniqueSongs = cleanedSongs.filter(
                (song) => !existingIds.has(song.id)
              );

              const updated = [...prev, ...uniqueSongs];

              if (currentSongIndex === null && updated.length > 0) {
                setCurrentSongIndex(0);
              }

              return updated;
            });

            if (currentSongIndex === null && cleanedSongs.length > 0) {
              setCurrentSongIndex(0);
            }

            setResetKey((prev) => prev + 1);
            setIsPlaying(false);
            resetMatcher();
          }}
        />

        {songLibrary.length > 0 && (
          <div
            style={{
              marginTop: '1rem',
              padding: '1rem',
              backgroundColor: '#fff',
              border: '1px solid #ddd',
              borderRadius: '8px',
            }}
          >
            <h3 style={{ marginTop: 0 }}>🎼 Song Library</h3>
            <p style={{ color: '#666', marginBottom: '1rem' }}>
              Uploaded songs: {songLibrary.length}
            </p>

            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                gap: '1rem',
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <select
                value={currentSongIndex ?? ''}
                onChange={(e) => {
                  const index = Number(e.target.value);
                  setCurrentSongIndex(index);
                  setResetKey((prev) => prev + 1);
                  setIsPlaying(false);
                  resetMatcher();
                }}
                style={{
                  padding: '0.6rem 0.9rem',
                  borderRadius: '6px',
                  border: '1px solid #bbb',
                  minWidth: '280px',
                }}
              >
                {songLibrary.map((song, index) => (
                  <option key={song.id} value={index}>
                    {song.name}
                  </option>
                ))}
              </select>

              <button
                onClick={() => {
                  if (currentSongIndex === null) return;

                  setSongLibrary((prev) => {
                    const updated = prev.filter(
                      (_, index) => index !== currentSongIndex
                    );

                    if (updated.length === 0) {
                      setCurrentSongIndex(null);
                    } else if (currentSongIndex >= updated.length) {
                      setCurrentSongIndex(updated.length - 1);
                    }

                    return updated;
                  });

                  setResetKey((prev) => prev + 1);
                  setIsPlaying(false);
                  resetMatcher();
                }}
                style={{
                  padding: '0.6rem 1rem',
                  borderRadius: '6px',
                  border: '1px solid #dc3545',
                  backgroundColor: '#fff',
                  color: '#dc3545',
                  cursor: 'pointer',
                }}
              >
                Remove Current Song
              </button>

              <button
                onClick={() => {
                  setSongLibrary([]);
                  setCurrentSongIndex(null);
                  setIsPlaying(false);
                  setExpectedNotes([]);
                  resetMatcher();
                }}
                style={{
                  padding: '0.6rem 1rem',
                  borderRadius: '6px',
                  border: '1px solid #999',
                  backgroundColor: '#f8f9fa',
                  cursor: 'pointer',
                }}
              >
                Clear Library
              </button>
            </div>
          </div>
        )}

        {targetSong && (
          <>
            <div
              style={{
                padding: '1rem',
                backgroundColor: '#d4edda',
                borderRadius: '8px',
                marginTop: '1rem',
                marginBottom: '1rem',
                border: '1px solid #c3e6cb',
              }}
            >
              <p
                style={{
                  color: '#155724',
                  fontWeight: 'bold',
                  margin: '0 0 0.5rem 0',
                }}
              >
                ✅ Song Loaded: {currentSongName || targetSong.name || 'Custom MIDI Track'}
              </p>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'center',
                  gap: '1rem',
                  flexWrap: 'wrap',
                  marginTop: '1rem',
                }}
              >
                <button
                  onClick={() => setIsPlaying((prev) => !prev)}
                  style={{
                    padding: '0.5rem 1.5rem',
                    fontSize: '1.2rem',
                    backgroundColor: isPlaying ? '#ffc107' : '#007bff',
                    color: isPlaying ? 'black' : 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  {isPlaying ? '⏸ Pause' : '▶️ Play'}
                </button>

                <button
                  onClick={() => setIsWaitMode((prev) => !prev)}
                  style={{
                    padding: '0.5rem 1rem',
                    fontSize: '1rem',
                    backgroundColor: isWaitMode ? '#6f42c1' : 'white',
                    color: isWaitMode ? 'white' : 'black',
                    border: '2px solid #6f42c1',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                  }}
                >
                  {isWaitMode ? 'Wait Mode: ON' : 'Wait Mode: OFF'}
                </button>

                <button
                  onClick={() => {
                    setResetKey((prev) => prev + 1);
                    setIsPlaying(false);
                    resetMatcher();
                  }}
                  style={{
                    padding: '0.5rem 1rem',
                    cursor: 'pointer',
                    borderRadius: '4px',
                    border: '1px solid #999',
                    backgroundColor: '#eee',
                  }}
                >
                  ⏪ Rewind
                </button>

                <button
                  onClick={() => {
                    setCurrentSongIndex(null);
                    setIsPlaying(false);
                    setExpectedNotes([]);
                    resetMatcher();
                  }}
                  style={{
                    padding: '0.5rem 1rem',
                    cursor: 'pointer',
                    borderRadius: '4px',
                    border: '1px solid #ccc',
                    backgroundColor: 'white',
                  }}
                >
                  Unload Song
                </button>
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '12px',
                marginTop: '1rem',
                textAlign: 'left',
              }}
            >
              <div
                style={{
                  background: '#fff',
                  border: '1px solid #ddd',
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <strong>Next expected</strong>
                <div>{currentExpected?.note || 'Done'}</div>
              </div>

              <div
                style={{
                  background: '#fff',
                  border: '1px solid #ddd',
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <strong>Accuracy</strong>
                <div>{accuracyPercent}%</div>
              </div>

              <div
                style={{
                  background: '#fff',
                  border: '1px solid #ddd',
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <strong>Streak</strong>
                <div>
                  {matcherState.sessionStats.streak} (best{' '}
                  {matcherState.sessionStats.bestStreak})
                </div>
              </div>

              <div
                style={{
                  background: '#fff',
                  border: '1px solid #ddd',
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <strong>Attempts</strong>
                <div>{matcherState.sessionStats.phrasesCompleted}</div>
              </div>
            </div>

            <div
              style={{
                marginTop: '1rem',
                textAlign: 'left',
              }}
            >
              <button
                onClick={() => setShowDebugPanel((prev) => !prev)}
                style={{
                  padding: '0.5rem 0.9rem',
                  borderRadius: '6px',
                  border: '1px solid #bbb',
                  backgroundColor: '#fff',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                }}
              >
                {showDebugPanel ? 'Hide Debug / Coach Log' : 'Show Debug / Coach Log'}
              </button>

              {showDebugPanel && (
                <div
                  style={{
                    marginTop: '0.75rem',
                    padding: '1rem',
                    background: '#fff',
                    border: '1px solid #ddd',
                    borderRadius: 8,
                  }}
                >
                  {lastPhraseSummary && (
                    <div
                      style={{
                        marginBottom: '1rem',
                        padding: '1rem',
                        background: '#fff8e1',
                        border: '1px solid #ffe082',
                        borderRadius: 8,
                      }}
                    >
                      <strong>Last Attempt</strong>
                      <div>Attempt #{lastPhraseSummary.phraseNumber}</div>
                      <div>Notes played: {lastPhraseSummary.playedNotes.length}</div>
                      <div>Errors: {lastPhraseSummary.errors.length}</div>
                      <div style={{ marginTop: 8 }}>
                        Recurring patterns:{' '}
                        {lastPhraseSummary.recurringErrors.length
                          ? lastPhraseSummary.recurringErrors.join(', ')
                          : 'None yet'}
                      </div>
                    </div>
                  )}

                  {feedbackLog.length > 0 ? (
                    <div>
                      <strong>Recent Attempt History</strong>
                      <div
                        style={{
                          marginTop: '0.75rem',
                          maxHeight: '220px',
                          overflowY: 'auto',
                          paddingRight: '6px',
                        }}
                      >
                        {feedbackLog.map((item) => (
                          <div
                            key={item.phraseNumber}
                            style={{
                              padding: '0.5rem 0',
                              borderBottom: '1px solid #eee',
                            }}
                          >
                            Attempt {item.phraseNumber}: {item.errors.length} errors,
                            accuracy {Math.round(item.sessionAccuracy * 100)}%
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: '#666', marginTop: '0.5rem' }}>
                      No attempt logs yet.
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div
        ref={scrollWrapperRef}
        style={{
          width: '100%',
          overflowX: 'auto',
          display: 'flex',
          paddingBottom: '2rem',
        }}
      >
        <div
          style={{
            margin: '0 auto',
            display: 'inline-flex',
            flexDirection: 'column',
          }}
        >
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
              playNote(note);
              setLocalNotes((prev) => ({ ...prev, [note]: true }));
              emitMidiEvent?.('note_on', note, 80, 'mouse');
            }}
            onStopNote={(note) => {
              stopNote(note);
              setLocalNotes((prev) => {
                const next = { ...prev };
                delete next[note];
                return next;
              });
              emitMidiEvent?.('note_off', note, 0, 'mouse');
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default App;