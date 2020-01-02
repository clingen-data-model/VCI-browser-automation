const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const yargs = require('yargs');


const Commands = Object.freeze({
    APROVE:   "approve",
    CLINVAR:  "clinvar",
});
// Settings for the differences between vci and vci test portals.
const DOMAIN_CONFIG = {
	'curation-test.clinicalgenome.org': {
		'login_button_selector': '.link~ .link+ .link span'
	},
	'curation.clinicalgenome.org': {
		'login_button_selector': '.link+ .link span'
	},
}

const DOMAIN = 'curation-test.clinicalgenome.org';

const CREDENTIALS_DATA = fs.readFileSync('credentials.json');
const CREDENTIALS = JSON.parse(CREDENTIALS_DATA);

const login = async(page) => {
	// Set affiliation cookie now so we don't have to go through affiliation selecting flow.
  	await page.setCookie({
	  	'domain': DOMAIN,
	  	'httpOnly': false,
	  	'name': 'affiliation',
	  	'path': '/',
	  	'sameSite': 'unspecified',
	  	'secure': false,
	  	'value': '{\"affiliation_id\":\"10029\",\"affiliation_fullname\":\"Broad Institute Rare Disease Group\",\"approver\":[\"Samantha Baxter\"]}',
	})

  	// Login selector, ugg no id. :( Clicks login button to open login modal.
	await page.click(DOMAIN_CONFIG[DOMAIN]['login_button_selector']);
	await page.waitFor('.auth0-lock-input-email .auth0-lock-input', {visible: true});

	// Login with credentials.
	await page.type('.auth0-lock-input-email .auth0-lock-input', CREDENTIALS.username);
	await page.type('.auth0-lock-input-password .auth0-lock-input', CREDENTIALS.password);
	await page.click('.auth0-lock-submit');
	await page.waitForNavigation();

	await page.waitFor('.affiliated-interpretation-list tr', {visible: true});
}

const filteredVariants = async(page, filterStatuses) => {
	trs = await page.$$('.affiliated-interpretation-list tbody tr');
	let retVariantLinks = []
	for (tr of trs) {
		const status = await tr.$('.label')
		const statusVal = await (await status.getProperty('innerText')).jsonValue();
		if (filterStatuses.includes(statusVal)) {
			const link = await tr.$('.affiliated-record-link');
			const linkVal = await (await link.getProperty('href')).jsonValue()

			const variantName = await tr.$('.variant-title strong');
			const variantNameVal = await (await link.getProperty('innerText')).jsonValue()
			retVariantLinks.push({'href': linkVal, 'name': variantNameVal});
		}
	}
	return retVariantLinks;
}

const btnWithText = async(page, btnText) => {
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

const handleBtnClick = async(page, btnText, waitForBtnText=null, screenshotName='progress.png', retries=3, timeout=1000) => {
	const btn = await btnWithText(page, btnText);
  	await btn.click();
  	if (waitForBtnText) {
  		await waitForBtn(page, waitForBtnText);
  	}
  	await page.screenshot({path: screenshotName, fullPage: true});
}

const handleApproveVariantPage = async(page, variant) => {
  	console.log(variant);
	dir = path.join('variants', variant.name);
  	if (!fs.existsSync(dir)) {
  		fs.mkdirSync(dir, { recursive: true });
  	}
	await page.goto(variant.href);
	// Stupid wait for n seconds because something has to load or else things get rendered badly.
	await page.waitFor(7000);
  	await page.waitFor('.view-summary');
  	await page.screenshot({path: path.join(dir, '1-initial.png'), fullPage: true});

  	await page.click('.view-summary');
  	await waitForBtn(page, 'Save');
  	await page.screenshot({path: path.join(dir, '2-view-summary.png'), fullPage: true});

  	await handleBtnClick(page, 'Save', 'Preview Provisional', '3-save.png');
  	// Yes, the end space in 'Submit Provisional ' is really there.
  	await handleBtnClick(page, 'Preview Provisional', 'Submit Provisional ', '4-preview-provisional.png');
  	await handleBtnClick(page, 'Submit Provisional ', 'Preview Approval', '5-submit-provisional.png');
  	await page.select('.form-control', 'Samantha Baxter');
  	await handleBtnClick(page, 'Preview Approval', 'Submit Approval ', '6-preview-approval.png');
  	await handleBtnClick(page, 'Submit Approval ', 'ClinVar Submission Data', '7-submit-approval.png');
}

const handleClinvarVariantPage = async(page, variant) => {
	console.log('handling clinvar variant page.')
	await page.goto(variant.href);
	// Stupid wait for n seconds because something has to load or else things get rendered badly.
	await page.waitFor(7000);
  	await page.waitFor('.view-summary');
  	await page.click('.view-summary');
  	await page.screenshot({path: 'progress.png', fullPage: true});

  	await handleBtnClick(page, 'ClinVar Submission Data', 'Generate', 'progress.png');

	await handleBtnClick(page, 'Generate', null, 'progress.png');
	await page.waitFor(2000);
	await page.screenshot({path: 'progress.png', fullPage: true});

}

function variantsFromCSV(variantFile) {
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

const handleVariants = async(page, argv, command, dryRun) => {
	let filter = null;
	if (command == Commands.APROVE) {
		filter = ['IN PROGRESS', 'PROVISIONAL'];
	} else if (command == Commands.CLINVAR) {
		filter = ['APPROVED'];
	}
	const variants = await filteredVariants(page, filter);

	const csvVariants = await variantsFromCSV(argv.variantFile);
    console.log(csvVariants)
    console.log(variants)
  	// Testing purposes, only do 2 at a time.
  	for (var i = 0; i < 1; i++) {
  		variant = variants[i];
        if (csvVariants.includes(variant.name)) {
            console.log('Handling variant ' + variant.name + '.');
            if (!dryRun) {
            	if (command == Commands.APROVE) {
            		await handleApproveVariantPage(page, variant);
            	} else if (command == Commands.CLINVAR) {
            		await handleClinvarVariantPage(page, variant);
            	}
            }
        } else {
            console.log('Variant ' + variant.name + ' not in csv file.');
        }
  	}
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
	  .argv;

	(async () => {
		const browser = await puppeteer.launch();
	  	const page = await browser.newPage();
	  	await page.goto('https://' + DOMAIN);

	  	await login(page);
	  	await handleVariants(page, argv, argv._, argv.dryRun != undefined && argv.dryRun);
	  	
	  	await browser.close();
	})();
}

main()


