'use strict';

import os from 'node:os';
import fs from 'node:fs';
import HttpsProxyAgent from 'https-proxy-agent';
import { config } from '@dotenvx/dotenvx';

config({path: '.env'});

const DEBUG = false;
const API_KEY = process.env.GOOGLE_WEB_FONTS_DEVELOPER_API_KEY;
if (typeof API_KEY === "undefined") {
  console.log('Missing env variable GOOGLE_WEB_FONTS_DEVELOPER_API_KEY! Use the provided .env file to store your Google fonts API key.');
  process.exit();
}

const FONTS_DEFINITION_FILE = 'fonts.json';
const ALL_FONTS_DUMP_FILE = 'all_google_fonts.json';
const FONTS_FOLDER = 'fonts';

const WEBFONTS_API_URL = new URL('https://www.googleapis.com/webfonts/v1/webfonts');
const CSS_API_URL = new URL('https://fonts.googleapis.com/css2');

const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36' };
const proxyUrl = process.env.https_proxy || process.env.http_proxy;
let agent;
if (typeof proxyUrl != "undefined" && proxyUrl.length > 0) {
  agent = new HttpsProxyAgent(proxyUrl);
}
const FETCH_OPTS = { headers: headers, agent: agent };

// Check if the config file exists in the current directory.
try {
  fs.accessSync(FONTS_DEFINITION_FILE, fs.constants.F_OK);
} catch (err) {
  fs.writeFileSync(FONTS_DEFINITION_FILE, JSON.stringify({}, null, 2));
}

// Check if the fonts folder exists.
try {
  fs.accessSync(FONTS_FOLDER, fs.constants.O_DIRECTORY);
} catch (err) {
  fs.mkdirSync(FONTS_FOLDER, { recursive: true });
}

// Read & parse the config file.
let fontsConfig = JSON.parse(fs.readFileSync(FONTS_DEFINITION_FILE));
const fontFamilies = Object.keys(fontsConfig);


(async () => {
  // Retrieve definitions for all fonts.
  WEBFONTS_API_URL.searchParams.append('key', API_KEY);
  WEBFONTS_API_URL.searchParams.append('sort', 'popularity');
  const response = await fetch(WEBFONTS_API_URL, FETCH_OPTS);
  const json = await response.json();

  // Clean definitions json.
  const allFonts = json.items;
  allFonts.forEach(function (fontDefinition) {
    delete fontDefinition.files;
    delete fontDefinition.kind;
  });

  // Dump definitions json for debugging.
  if (DEBUG) {
    fs.writeFile(ALL_FONTS_DUMP_FILE, JSON.stringify(allFonts, null, 2), (err) => {
      if (err) throw err;
    });
  }

  
  // Loop throught the monitored fonts.
  let output = '';
  for (const fontFamily of fontFamilies) {
    process.stdout.write(`Processing '${fontFamily}': `);

    const fontFamilyFolder = [FONTS_FOLDER, '/', fontFamily].join('');
    const localFontVersion = fontsConfig[fontFamily];
    let remoteFontVersion = '';

    // Retrieve server font version.
    for (let font of allFonts) {
      if (font.family == fontFamily) {
        remoteFontVersion = font.version;
        break;
      }
    }

    // Check if font family exists.
    if (remoteFontVersion === '') {
      console.log("font family doesn't exist on server! Is the spelling correct?");
      continue;
    }

    // Check versions.
    if (remoteFontVersion === localFontVersion) {
      console.log(`version ${localFontVersion} already present, skipping.`);
      continue;
    }

    process.stdout.write(`new version ${remoteFontVersion} found... `);
    output += `${fontFamily} ${localFontVersion} -> ${remoteFontVersion}\n`;

    // Check for font family folder.
    try {
      fs.accessSync(fontFamilyFolder, fs.constants.O_DIRECTORY);
    } catch (err) {
      fs.mkdirSync(fontFamilyFolder, { recursive: true });
    }

    // Prepare call to CSS API.
    const cssParams = [];
    cssParams.push(fontFamily);
    cssParams.push(':');
    cssParams.push('ital,wght');
    cssParams.push('@');
    cssParams.push('0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900');
    cssParams.push(';');
    cssParams.push('1,100;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900');
    // cleanup & re-append CSS API parameters
    CSS_API_URL.searchParams.delete('family');
    CSS_API_URL.searchParams.delete('display');
    CSS_API_URL.searchParams.append('family', cssParams.join(''));
    CSS_API_URL.searchParams.append('display', 'swap');

    // Fetch CSS / font family.
    fetch(CSS_API_URL, FETCH_OPTS)
      .then(res => res.text())
      .then(cssBody => {
        const reBlock = /\/\*\s([a-z-]+)\s\*\/([^}]+})/g;
        const reStyle = /font-style:\s*([^;]+);/;
        const reWeight= /font-weight:\s*([^;]+);/;
        const reWoff  = /url\((https:\/\/fonts\.gstatic\.com[^.]+\.woff2)\)/;

        // Parse subset blocks
        const matches = [...cssBody.matchAll(reBlock)];
        matches.forEach(cssBlock => {
          const subset  = cssBlock[1];
          let fontBlock = cssBlock[0];
          const style   = fontBlock.match(reStyle)[1] == 'normal' ? '' : fontBlock.match(reStyle)[1];
          const weight  = fontBlock.match(reWeight)[1];
          const fontUrl = fontBlock.match(reWoff)[1];

          // Generate local font file name.
          const fontFileName = [
              [
                fontFamily.replace(' ', '-'),
                remoteFontVersion,
                subset,
                weight
              ].join('-'),
              style,
              '.woff2'
            ].join('');

          // Fetch font files (.woff).
          fetch(fontUrl, FETCH_OPTS)
            .then(res => res.arrayBuffer())
            .then(arrayBuffer => fs.writeFile(
              [fontFamilyFolder, '/', fontFileName].join(''), 
              Buffer.from(arrayBuffer), 
              (err) => {
                if (err) throw err;
              }
            ));

          // Replace remote URLs with local.
          cssBody   = cssBody.replace(fontUrl, ["'", fontFileName, "'"].join(''));
          fontBlock = fontBlock.replace(fontUrl, ["'", fontFileName, "'"].join(''));

          // Write CSS file to disk.
          const cssSubsetFileName = [
              [
                fontFamily.replace(' ', '-'),
                remoteFontVersion,
                subset
              ].join('-'),
              '.css'
            ].join('');

          fs.appendFile([fontFamilyFolder, '/', cssSubsetFileName].join(''), fontBlock + os.EOL, (err) => {
              if (err) throw err;
            });
  
        });

        // Write CSS file to disk.
        const cssFileName = [
            [
              fontFamily.replace(' ', '-'),
              remoteFontVersion,
              'all'
            ].join('-'),
            '.css'
          ].join('');

        fs.writeFile([fontFamilyFolder, '/', cssFileName].join(''), cssBody, (err) => {
            if (err) throw err;
          });
      });

    // Update local version.
    if (!DEBUG) {
      fontsConfig[fontFamily] = remoteFontVersion;
    }

    console.log('done!');

    // Wait a bit so connection is not closed for throttling.
    await sleep(1000);
  }

  // Write updated fonts config file.
  fs.writeFile(FONTS_DEFINITION_FILE, JSON.stringify(fontsConfig, null, 2), (err) => {
      if (err) throw err;
    });

  if (output.length > 0) {
    console.log('Summary:');
    console.log(output);
  }
})();  



function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
