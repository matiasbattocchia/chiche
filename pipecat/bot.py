"""
bot.py — agent 1 on Pipecat: the same session (model, voice, INSTRUCTIONS.md) over
Pipecat's Gemini Live service and its local PyAudio transport, instead of our own
audio.ts / conversation.ts. A comparison rig: does a framework that many people run
against this API behave differently on the same machine, same room, same key?

Echo cancellation stays ours: run.sh raises the PipeWire echo-cancel process and moves
this process's streams onto its nodes.

    uv run bot.py            # open mic, server VAD (as the app)
"""
import asyncio
import os
import sys
import time
from pathlib import Path

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame, BotStoppedSpeakingFrame, EndFrame, InputAudioRawFrame, InterruptionFrame,
    TranscriptionFrame, TTSAudioRawFrame, TTSTextFrame, LLMFullResponseEndFrame,
)
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService
from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams

MODEL = "gemini-3.1-flash-live-preview"
VOICE = "Kore"
INSTRUCTION = (Path(__file__).resolve().parent.parent / "INSTRUCTIONS.md").read_text().strip()
if os.environ.get("ASCII_ONLY"):
    # diagnosing "Invalid ASCII character": strip accents from the instruction
    import unicodedata
    INSTRUCTION = unicodedata.normalize("NFKD", INSTRUCTION).encode("ascii", "ignore").decode()


class Pacing(FrameProcessor):
    """The same markers the app prints: what arrives, when, and at what rate."""

    def __init__(self):
        super().__init__()
        self.t0 = time.monotonic()
        self.first_audio = None
        self.last_audio = 0.0
        self.audio_s = 0.0
        self.last_input = None
        self.mic_frames = 0
        self.mic_report = 0.0

    def t(self):
        return time.monotonic() - self.t0

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        now = self.t()
        if isinstance(frame, InputAudioRawFrame):
            self.mic_frames += 1
            if now - self.mic_report >= 5:
                print(f"{now:7.2f} [mic: {self.mic_frames} frames so far]", flush=True)
                self.mic_report = now
        if isinstance(frame, TranscriptionFrame):
            print(f"{now:7.2f} vos › {frame.text}", flush=True)
            self.last_input = now
        elif isinstance(frame, TTSTextFrame):
            print(f"{now:7.2f} voz › {frame.text}", flush=True)
        elif isinstance(frame, TTSAudioRawFrame):
            if self.first_audio is None:
                self.first_audio = now
                late = "" if self.last_input is None else f" · {now - self.last_input:.1f}s after your speech"
                print(f"{now:7.2f} [first audio{late}]", flush=True)
            elif now - self.last_audio > 1.5:
                print(f"{now:7.2f} [servidor entrega lento · {now - self.last_audio:.1f}s sin audio]", flush=True)
            self.last_audio = now
            self.audio_s += len(frame.audio) / 2 / frame.sample_rate
        elif isinstance(frame, (LLMFullResponseEndFrame, InterruptionFrame)):
            if self.first_audio is not None:
                stream = self.last_audio - self.first_audio
                ratio = self.audio_s / stream if stream > 0.5 else float("nan")
                cut = " ✂" if isinstance(frame, InterruptionFrame) else ""
                print(f"{now:7.2f} [turn: {self.audio_s:.1f}s audio in {stream:.1f}s ({ratio:.1f}x){cut}]", flush=True)
            self.first_audio = None
            self.audio_s = 0.0
        await self.push_frame(frame, direction)


async def main():
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        print("falta GEMINI_API_KEY (mise lo carga desde .env)", file=sys.stderr)
        sys.exit(1)

    transport = LocalAudioTransport(LocalAudioTransportParams(
        audio_in_enabled=True,
        audio_out_enabled=True,
        audio_in_sample_rate=16000,
        audio_out_sample_rate=24000,
    ))
    llm = GeminiLiveLLMService(
        api_key=api_key,
        model=MODEL,
        voice_id=VOICE,
        system_instruction=INSTRUCTION,
    )
    # The service only streams mic audio once a context has been set (its
    # _ready_for_realtime_input), so the aggregator pair is not optional.
    context = LLMContext()
    aggregators = LLMContextAggregatorPair(context)
    # Two instances: a processor links to exactly one successor, so one instance in two
    # places would route the mic straight past the LLM.
    mic_side, reply_side = Pacing(), Pacing()
    pipeline = Pipeline([
        transport.input(), aggregators.user(), mic_side, llm, reply_side, transport.output(), aggregators.assistant(),
    ])
    task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))
    await task.queue_frames([LLMRunFrame()])
    print(f"Pipecat · {MODEL} · hablá (ctrl-c para salir)", flush=True)
    await PipelineRunner(handle_sigint=True).run(task)


if __name__ == "__main__":
    logger.remove()
    logger.add(sys.stderr, level=os.environ.get("LOG", "WARNING"))
    asyncio.run(main())
