const wf = require('./utils/wordFilterManager');
const testMsg = 'ADMIN [` VaultXII `](<https://dsc.gg/vaultxii>) halooo';
const result = wf.testFilter(testMsg);
console.log('Words:', wf.getSettings().words);
console.log('Test string:', testMsg);
console.log('Output:', result.result);
console.log('Removed:', result.removedWords);
