#!/usr/bin/env node
// Prints a JSONL fixture ($FAKE_FIXTURE) line by line, then exits with $FAKE_EXIT (default 0).
import { readFileSync } from 'node:fs';
process.stdout.write(readFileSync(process.env.FAKE_FIXTURE, 'utf8'));
process.exit(Number(process.env.FAKE_EXIT ?? 0));
