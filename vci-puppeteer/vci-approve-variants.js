const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const yargs = require('yargs');


const Commands = Object.freeze({
    APROVE:   "approve",
    CLINVAR:  "clinvar",
});

const DOMAIN_TEST = 'curation-test.clinicalgenome.org';
const DOMAIN_PROD = 'curation.clinicalgenome.org';

// Settings for the differences between vci and vci test portals.
const DOMAIN_CONFIG = {
	DOMAIN_TEST: {
		domain: 'curation-test.clinicalgenome.org',
		login_button_selector: '.link~ .link+ .link span'
	},
	DOMAIN_PROD: {
		domain: 'curation.clinicalgenome.org',
		login_button_selector: '.link+ .link span'
	},
}

const CREDENTIALS_DATA = fs.readFileSync('credentials.json');
const CREDENTIALS = JSON.parse(CREDENTIALS_DATA);

function setDifference(setA, setB) {
	return new Set([...setA].filter(x => !setB.has(x)));
}

function setIntersection(setA, setB) {
	return new Set([...setA].filter(x => setB.has(x)));
}

const filteredVariants = async(page, filterStatuses) => {
	/*
	 Grabs all the variants from the interpretations list and returns a list of variants in
	 with status in filterStatuses.
	*/
	let trs = await page.$$('.affiliated-interpretation-list tbody tr');
	let retVariantLinks = new Map();
	for (tr of trs) {
		const status = await tr.$('.label');
		if (status) {
			const statusVal = await (await status.getProperty('innerText')).jsonValue();
			if (filterStatuses.includes(statusVal)) {
				const link = await tr.$('.affiliated-record-link');
				const linkVal = await (await link.getProperty('href')).jsonValue();

				const variantName = await tr.$('.variant-title strong');
				const variantNameVal = await (await link.getProperty('innerText')).jsonValue();
				retVariantLinks.set(variantNameVal, {'href': linkVal});
			}
		}
	}
	return retVariantLinks;
}

const btnWithText = async(page, btnText) => {
	/* 
	 Find a button with a certain text by grabbing all class 'btn' and searching for
	 the one with the provided text.
	*/
	const btns = await page.$$('.btn');
	for (btn of btns) {
		/* The property is sometimes innerText and sometimes value, go figure. */
		if (await (await btn.getProperty('innerText')).jsonValue() == btnText) {
			return btn;
		}
		if (await (await btn.getProperty('value')).jsonValue() == btnText) {
			return btn;
		}
	}
	return null;
}

const waitForBtn = async(page, btnText, retries=5, timeout=1000) => {
	/*
	  Waits for a button element with a certain text. 
	*/
	for (var i = 0; i < retries; i++) {
		const btn = await btnWithText(page, btnText);
		if (btn != null) {
			return;
		}
		await page.waitFor(timeout);
		// console.log('Try' + i + '. Could not find button ' + btnText)
	}
	throw 'Could not find button ' + btnText;
}

const handleBtnClick = async(page, btnText, waitForBtnText=null, screenshotName=null, retries=3, timeout=1000) => {
	/* 
	  Waits for a button with a certain text and clicks on it. If `waitForBtnText` is provided, it will then wait
	  for that button to appear. If screenshot provided, snaps a screenshot.
	*/
	const btn = await btnWithText(page, btnText);
  	await btn.click();
  	if (waitForBtnText) {
  		await waitForBtn(page, waitForBtnText);
  	}
  	if (screenshotName) {
		await page.screenshot({path: screenshotName, fullPage: true});
  	}
}

function variantDir(variantName) {
	/* 
	  Returns a directory for the variant (creates dir if it does not exist).
	*/
	dir = path.join('variants', variantName);
  	if (!fs.existsSync(dir)) {
  		fs.mkdirSync(dir, { recursive: true });
  	}
  	return dir;
}

const handleApproveVariantPage = async(page, variant) => {
	const dir = variantDir(variant.name)
	await page.goto(variant.href);
	// Stupid wait for n seconds because something has to load or else things get rendered badly.
	await page.waitFor(7000);
  	await page.waitFor('.view-summary');
  	await page.screenshot({path: path.join(dir, '1-initial.png'), fullPage: true});

  	await page.click('.view-summary');
  	await waitForBtn(page, 'Save');
  	await page.screenshot({path: path.join(dir, '2-view-summary.png'), fullPage: true});

  	await handleBtnClick(page, 'Save', 'Preview Provisional', path.join(dir,'3-save.png'));
  	await handleBtnClick(page, 'Preview Provisional', 'Submit Provisional ', path.join(dir,'4-preview-provisional.png'));
  	// Yes, the end space in 'Submit Provisional ' is really there.
  	await handleBtnClick(page, 'Submit Provisional ', 'Preview Approval', path.join(dir,'5-submit-provisional.png'));
  	await page.select('.form-control', 'Samantha Baxter');
  	await handleBtnClick(page, 'Preview Approval', 'Submit Approval ', path.join(dir,'6-preview-approval.png'));
  	await handleBtnClick(page, 'Submit Approval ', 'ClinVar Submission Data', path.join(dir,'7-submit-approval.png'));
}

const handleClinvarVariantPage = async(page, variant, aggregateCsvFile) => {
	console.log('handling clinvar variant page.')
	const dir = variantDir(variant.name)

	// Default string is an error with the variant name to be appended to the growing file so we know which variant failed.
	let clinvarString = 'ERROR: ' + variant.name;
	try {
		await page.goto(variant.href);
		// Stupid wait for n seconds because something has to load or else things get rendered badly.
		await page.waitFor(7000);
	  	await page.waitFor('.view-summary');
	  	await page.click('.view-summary');
	  	await page.screenshot({path: 'progress.png', fullPage: true});

	  	await handleBtnClick(page, 'ClinVar Submission Data', 'Generate', 'progress.png');

		await handleBtnClick(page, 'Generate', null, 'progress.png');
		await page.waitFor('#generated-clinvar-submission-data table tr td');
		await page.screenshot({path: 'progress.png', fullPage: true});

		// Grab the clinvar table.
		const clinvarData = await page.evaluate(() => {
		    const tds = Array.from(document.querySelectorAll('#generated-clinvar-submission-data table tr td'));
		    return tds.map(td => td.innerText);
		});

		clinvarString = clinvarData.join('\t');

		// Write to a file. 
		const clinvarCsvPath = path.join(dir, 'clinvar.tsv');
		fs.writeFile(clinvarCsvPath, clinvarString + '\n', (err) => {
		    if (err) throw err;
		    console.log('=====');
		    console.log('Wrote the following to ' + clinvarCsvPath + ':');
		    console.log(clinvarString);
		    console.log('=====');
		})
	} catch(err) {
		throw err;
	} finally {
		// In all cases, append to file (if error, we have the default variant name as placeholder).
		fs.appendFile(aggregateCsvFile, clinvarString + '\n', (err) => {
		    if (err) throw err;
		    console.log('=====');
		    console.log('Appended to aggregate file ' + aggregateCsvFile);
		    console.log('=====');
		})
	}
}

function variantsFromCSV(variantFile) {
	/* 
	Grabs all variants from the csv. 
	*/
    return new Promise((resolve, reject) => {
        var results = []
        fs.createReadStream(variantFile)
            .pipe(csv())
            .on('data', (data) => results.push(data.Variant))
            .on('end', () => {
                resolve(results);
            });  
    });
}

const handleVariants = async(page, variantFile, command, dryRun) => {
	let filter = null;
	if (command == Commands.APROVE) {
		filter = ['IN PROGRESS', 'PROVISIONAL'];
	} else if (command == Commands.CLINVAR) {
		filter = ['APPROVED'];
	}
	// Variants from the page with the filter applied.
	const pageVariants = await filteredVariants(page, filter);

	let variantsToIterate = [...pageVariants.keys()];
	// variantFile given.
	if (variantFile) {
		const csvVariants = await variantsFromCSV(variantFile);

		const csvVariantsSet = new Set(csvVariants);
		const pageVariantSet = new Set([...pageVariants.keys()]);
		const variantIntersection = setIntersection(csvVariantsSet, pageVariantSet);

		console.log('There are ' + variantIntersection.size + ' variant(s) from the CSV that are also on the page');
		console.log(variantIntersection);
		console.log('The following variants are in the csv but not on the page:');
		console.log(setDifference(csvVariantsSet, pageVariantSet));
		console.log('The following variants are on the page but not in the csv:');
		console.log(setDifference(pageVariantSet, csvVariantsSet));
		variantsToIterate = Array.from(variantIntersection);
	} 

	// CSV file that agregates all the clinvar submissions (used only if clinvar command selected).
	const aggregateCsvFile = 'clinvar-submission-' + Math.round(new Date().getTime()/1000).toString() + '.tsv';
  	for (var variant of variantsToIterate) {
        console.log('Handling variant ' + variant + '.');
        if (!dryRun) {
        	try {
        		if (command == Commands.APROVE) {
            		await handleApproveVariantPage(page, {name: variant, href: pageVariants.get(variant).href});
            	} else if (command == Commands.CLINVAR) {
            		await handleClinvarVariantPage(page, {name: variant, href: pageVariants.get(variant).href}, aggregateCsvFile);
            	}
        	} catch(err) {
        		console.error(err);
        	}
        }
  	}
}

const login = async(page, domain) => {
	// Set affiliation cookie now so we don't have to go through affiliation selecting flow.
  	await page.setCookie({
	  	'domain': DOMAIN_CONFIG[domain].domain,
	  	'httpOnly': false,
	  	'name': 'affiliation',
	  	'path': '/',
	  	'sameSite': 'unspecified',
	  	'secure': false,
	  	'value': '{\"affiliation_id\":\"10029\",\"affiliation_fullname\":\"Broad Institute Rare Disease Group\",\"approver\":[\"Samantha Baxter\"]}',
	})

  	// Login selector, ugg no id. :( Clicks login button to open login modal.
	await page.click(DOMAIN_CONFIG[domain]['login_button_selector']);
	await page.waitFor('.auth0-lock-input-email .auth0-lock-input', {visible: true});

	// Login with credentials.
	await page.type('.auth0-lock-input-email .auth0-lock-input', CREDENTIALS.username);
	await page.type('.auth0-lock-input-password .auth0-lock-input', CREDENTIALS.password);
	await page.click('.auth0-lock-submit');
	await page.waitForNavigation();

	// If there are many interpretations, this sometimes takes a long time to load. Increase the timeout if it gets stuck.
	await page.waitFor('.affiliated-interpretation-list tbody tr', {visible: true, timeout: 120000});
}

function main() {
	const argv = yargs
	  .command(Commands.APROVE, 'Automate the approval of variants')
	  .command(Commands.CLINVAR, 'Automate the extraction of variant data for clinvar submission')
	  .help()
	  .option('variant-file', {
	      alias: 'v',
	  })
	  .boolean('dry-run')
	  .boolean('prod')
	  .argv;

	let domain = (argv.prod) ? 'DOMAIN_PROD' : 'DOMAIN_TEST';

	(async () => {
		const browser = await puppeteer.launch();
		try {
		  	const page = await browser.newPage();
		  	await page.goto('https://' + DOMAIN_CONFIG[domain].domain);

		  	await login(page, domain);
		  	await handleVariants(page, argv.variantFile, argv._, argv.dryRun != undefined && argv.dryRun);
		} catch(err) {
			console.error(err);
		} finally {
		  	await browser.close();
		}
	})();
}

main()


