// Curated answer pool: familiar, everyday English words.
// No proper nouns, no obscure vocabulary, nothing offensive.
// The daily order is a secret shuffle of this list (see puzzle.js).
module.exports = `
apple bread cheese butter honey sugar salt pepper coffee tea milk juice soup rice pasta pizza cake cookie
candy chocolate egg banana orange lemon grape cherry peach strawberry potato tomato onion carrot corn bean
dinner breakfast lunch kitchen oven spoon fork knife plate bowl cup bottle basket
dog cat horse cow pig sheep goat chicken duck rabbit mouse bird eagle owl fish shark whale dolphin frog
snake turtle lion tiger bear wolf fox deer monkey elephant giraffe zebra bee butterfly spider ant
tree flower grass leaf forest garden seed rose river lake ocean sea beach island mountain hill valley desert
cave rock stone sand mud ice snow rain cloud storm thunder lightning wind fog rainbow sun moon star sky
planet earth fire smoke water air light shadow night morning evening winter summer spring autumn season
house home door window wall roof floor stairs room bed chair table desk lamp mirror clock pillow blanket
sofa garage fence bridge road street city village town tower castle church school hospital library museum
market shop bank office factory farm station airport hotel restaurant prison park zoo theater stadium
car truck bus train plane boat ship bicycle rocket wheel engine ticket map journey travel vacation
shirt dress shoe hat coat jacket glove sock scarf ring necklace umbrella bag wallet key coin money gold
silver diamond treasure gift box letter card book paper pencil pen poem story picture painting photo
camera phone computer television radio robot machine tool hammer ladder rope chain needle candle balloon
music song guitar piano drum violin dance party wedding birthday holiday festival game ball toy puzzle
doctor teacher farmer soldier police artist singer pilot king queen prince princess baby child friend
family mother father brother sister neighbor stranger hero thief ghost monster dragon wizard angel giant
heart brain hand finger foot eye ear nose mouth tooth hair skin bone blood face voice smile tear dream
sleep laugh cry kiss hug walk run jump swim fly climb sing write read cook paint build fight hide win
happy sad angry afraid brave calm proud lonely tired hungry lucky famous quiet loud bright dark cold hot
warm sweet bitter soft hard heavy fast slow young old new rich poor strong empty clean dirty wild
love hate fear hope joy anger peace war truth lie luck danger secret memory idea plan question answer
problem mistake chance choice reason power energy freedom justice beauty wisdom courage silence noise
time history future past moment minute hour week year century birth death life health medicine disease
science math language word name number color shape circle square line point edge corner center
mystery magic adventure journey victory defeat battle sport team race goal prize trophy medal
newspaper message news money price job work business money career contract meeting lesson exam homework
island volcano earthquake flood tornado glacier jungle meadow canyon harbor lighthouse anchor sail
mirror shadow echo whisper storm sunrise sunset horizon compass telescope microscope battery magnet
`
  .split(/\s+/)
  .filter(Boolean)
  .filter((w, i, all) => all.indexOf(w) === i); // de-duplicate
