import { runAllBenchmarks } from './runner.js';
import { config } from '../src/config/index.js';

async function main() {
  console.log('\n========================================================================================');
  console.log('   AUTONOMOUS AI CODING ORCHESTRATOR — LIVE LLM BENCHMARK RUNNER');
  console.log('========================================================================================\n');

  if (!config.geminiApiKey) {
    console.error('❌ Error: GEMINI_API_KEY is required to run live model benchmarks.');
    console.error('Please set the environment variable and re-run:');
    console.error('   $env:GEMINI_API_KEY="your-gemini-api-key" ; npm run benchmark:live\n');
    process.exit(1);
  }

  console.log(`Model Target : ${config.geminiModel}`);
  console.log(`Execution Mode: Live LLM Inference & Autonomous Verification`);
  console.log('----------------------------------------------------------------------------------------\n');

  const filterArg = process.argv.find((a) => a.startsWith('--filter='));
  const filterId = filterArg ? filterArg.split('=')[1] : undefined;

  try {
    const summary = await runAllBenchmarks({
      isLive: true,
      filterId,
    });
    console.log(`Live benchmark run completed successfully. Total tokens: ${summary.totalTokens}`);
  } catch (err: any) {
    console.error('Live benchmark execution failed:', err);
    process.exit(1);
  }
}

main();

