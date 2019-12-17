const fs = require('fs');
var path = require('path');
const puppeteer = require('puppeteer');

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
		if (await (await btn.getProperty('innerText')).jsonValue() == btnText) {
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
  	await page.screenshot({path: path.join(dir, screenshotName), fullPage: true});
  	return;

}

const handleVariantPage = async(page, variant) => {
  	console.log(variant);
	dir = path.join('variants', variant['name']);
  	if (!fs.existsSync(dir)){
  		fs.mkdirSync(dir, { recursive: true });
  	}
	await page.goto(variant['href']);
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

(async () => {
	const browser = await puppeteer.launch();
  	const page = await browser.newPage();
  	await page.goto('https://' + DOMAIN);

  	await login(page);

  	const variants = await filteredVariants(page, ['IN PROGRESS', 'PROVISIONAL']);

  	// Testing purposes, only do 2 at a time.
  	for (var i = 0; i < 2; i++) {
  		await handleVariantPage(page, variants[i]);
  	}
  	
  	await browser.close();
})();

