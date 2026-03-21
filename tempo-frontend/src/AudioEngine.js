import * as Tone from 'tone';

// Create a polyphonic synthesizer (can play multiple notes at once) and route it to the speakers
const synth = new Tone.PolySynth(Tone.Synth).toDestination();

export const playNote = (note) => {
  // Trigger the note immediately
  synth.triggerAttack(note);
};

export const stopNote = (note) => {
  // Release the note immediately
  synth.triggerRelease(note);
};

export const startAudioContext = async () => {
  // Browsers require a user action before audio can play
  await Tone.start();
  console.log('Audio Context Started');
};