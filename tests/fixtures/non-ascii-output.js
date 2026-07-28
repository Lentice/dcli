/**
 * Fixture: outputs non-ASCII UTF-8 text to test mojibake prevention.
 */
const text = [
  'hello 世界',
  'café résumé',
  '¡Hola! 你好 ñoño',
  '日本語テスト',
  'русский язык',
  '😀🚀测试完成',
  'NON_ASCII_END',
].join('\n');

process.stdout.write(text + '\n');

// Also read stdin to allow interactive test pattern
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.exit(0));
