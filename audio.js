// Keep the two channels independent. This does not mix stereo down to mono.
export function connectCorrection(context, source, destination, { muted = false } = {}) {
  const stereo = new GainNode(context, {
    gain: 1, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers'
  });
  const splitter = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
  const left = new GainNode(context, { gain: 1 });
  const right = new GainNode(context, { gain: -1 });
  const merger = new ChannelMergerNode(context, { numberOfInputs: 2 });
  const output = new GainNode(context, { gain: 0 });
  source.connect(stereo);
  stereo.connect(splitter);
  splitter.connect(left, 0);
  splitter.connect(right, 1);
  left.connect(merger, 0, 0);
  right.connect(merger, 0, 1);
  merger.connect(output);
  output.connect(destination);
  output.gain.setValueAtTime(0, context.currentTime);
  output.gain.linearRampToValueAtTime(muted ? 0 : 1, context.currentTime + 0.012);
  let disconnected = false;
  return {
    setMuted(value) {
      if (disconnected) return;
      const now = context.currentTime;
      output.gain.cancelScheduledValues(now);
      output.gain.setValueAtTime(output.gain.value, now);
      output.gain.linearRampToValueAtTime(value ? 0 : 1, now + 0.012);
    },
    async fadeOut() {
      if (disconnected || context.state !== 'running') return;
      const now = context.currentTime;
      output.gain.cancelScheduledValues(now);
      output.gain.setValueAtTime(output.gain.value, now);
      output.gain.linearRampToValueAtTime(0, now + 0.012);
      await new Promise(resolve => setTimeout(resolve, 16));
    },
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      for (const node of [source, stereo, splitter, left, right, merger, output]) node.disconnect();
    }
  };
}
