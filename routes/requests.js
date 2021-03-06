const express = require('express');
const request = require('request-promise-native');
const RateLimit = require('express-rate-limit');
const uuid = require('uuid/v4');
const validator = require('validator');

var config = require('../config');
const {checkRequestCancelToken} = require('../lib/tokens');
const {saveCityInformation, cancelMatch} = require('../lib/actions');
var {redis, mailer, consts} = require('../index');
var router = express.Router();
var wrap = fn => (...args) => fn(...args).catch(args[2]);

var limiter = new RateLimit({
  windowMs: 60*1000, // 15 minutes
  max: 3
});

router.get('/', (req, res) => {
  var errors = req.session.errors;
  delete req.session.errors;

  res.render('step1', {errors});
});

// Handle form, create token to validate email adress and send link by email
router.post('/etape-1', limiter, wrap(async (req, res, next) => {
  if (!req.body.email || !validator.isEmail(req.body.email)) {
    req.session.errors = {};
    req.session.errors['email'] = 'Email invalide.';

    return res.redirect('/');
  }

  // If email does not exist, push in the list
  if (!await redis.getAsync(`requests:${req.body.email}:valid`)) {
    await redis.lpushAsync('requests:all', req.body.email);
  }

  var token = uuid();
  await redis.setAsync(`requests:${token}`, req.body.email);
  await redis.setAsync(`requests:${req.body.email}:valid`, false);

  var emailContent = await request({
    uri: config.mails.step1,
    qs: {
      EMAIL: req.body.email,
      LINK: `${config.host}/etape-1/confirmation/${token}`
    }
  });

  var mailOptions = Object.assign({
    to: req.body.email,
    subject: 'Votre procuration',
    html: emailContent
  }, config.emailOptions);

  mailer.sendMail(mailOptions, (err) => {
    if (err) return next(err);

    res.redirect('/etape-1/confirmation');
  });
}));

// Thanks you page for step 1
router.get('/etape-1/confirmation', (req, res) => {
  res.render('step1Confirm');
});

// Validate email address with token
router.get('/etape-1/confirmation/:token', wrap(async (req, res) => {
  var email = await redis.getAsync(`requests:${req.params.token}`);
  if (!email) {
    return res.status(401).render('errorMessage', {
      message: 'Ce lien est invalide ou périmé. Cela signifie probablement que vous\
      avez demandé et reçu un autre lien plus récemment. Merci de vérifier dans\
      votre boîte mail.'
    });
  }

  req.session.email = email;
  await redis.setAsync(`requests:${email}:valid`, new Date());

  res.redirect('/etape-2');
}));

// Form for step 2
router.use('/etape-2', wrap(async (req, res, next) => {
  if (!req.session.email) {
    return res.status(401).render('errorMessage', {
      message: 'Vous devez cliquer sur le lien dans le mail que vous avez reçu\
      pour accéder à cette page.'
    });
  }

  if (await redis.getAsync(`requests:${req.session.email}:match`)) {
    return res.status(401).render('errorMessage', {
      message: 'Vous avez déjà reçu un mail vous indiquant comment prendre contact\
      avec la personne qui prendra votre procuration.'
    });
  }

  next();
}));

router.get('/etape-2', wrap(async (req,res) => {
  var errors = req.session.errors;
  delete req.session.errors;

  var commune = (await redis.getAsync(`requests:${req.session.email}:commune`));

  res.render('step2', {email: req.session.email, commune, errors});
}));

// Handle form, send emails to random people
router.post('/etape-2', wrap(async (req, res) => {
  if (!req.body.commune)  { // req.body.commun should be commune code INSEE
    req.session.errors = {};
    req.session.errors['commune'] = 'Ce champ ne peut être vide.';

    return res.redirect('/etape-2');
  }

  // Get commune zipcodes
  var ban = await request({
    uri: 'https://api-adresse.data.gouv.fr/search/',
    qs: {
      q: req.body.commune,
      type: 'municipality',
      citycode: req.body.commune
    },
    json: true
  });

  if (!ban.features.length) { // if commune does not exist, return to the form
    req.session.errors = {};
    req.session.errors['commune'] = 'Commune inconnue.';

    return res.redirect('/etape-2');
  }

  var zipcodes = ban.features.map(feature => (feature.properties.postcode));
  const insee = ban.features[0].properties.citycode;
  const name = ban.features[0].properties.city;
  const context = ban.features[0].properties.context;

  // Increment number of change so it cannot be greater than 3
  if (await redis.incrAsync(`requests:${req.session.email}:changes`) > 3) {
    req.session.errors = {};
    req.session.errors['commune'] = 'Vous ne pouvez pas changer de commune plusieurs fois.';

    return res.redirect('/etape-2');
  }

  await saveCityInformation(insee, {name, context, zipcodes});
  await redis.setAsync(`requests:${req.session.email}:insee`, insee);
  // for statistics purpose
  await redis.setAsync(`requests:${req.session.email}:date`, Date.now());
  // LEGACY
  await redis.setAsync(`requests:${req.session.email}:commune`, `${name} (${context})`);

  res.redirect('/etape-2/confirmation');
}));


router.get('/etape-2/confirmation', (req, res) => {
  res.render('end');
});

router.get('/etape-2-liste-consulaire', wrap(async (req,res) => {
  var errors = req.session.errors;
  delete req.session.errors;

  var commune = (await redis.getAsync(`requests:${req.session.email}:commune`));

  res.render('step2-liste-consulaire', {email: req.session.email, commune, errors});
}));

router.post('/etape-2-liste-consulaire', wrap(async (req, res, next) => {
  if (!req.body.liste)  { // one should be filled
    req.session.errors = {};
    req.session.errors['liste'] = 'Ce champ ne peut être vide.';

    return res.redirect('/step2-liste-consulaire');
  }

  var mailOptions = Object.assign({
    to: config.lecDest,
    subject: `Demande LEC (${req.session.email} - ${req.body.liste})`,
    text: `Boujour,\n\nNouvelle demande de procuration de ${req.session.email} pour la liste ${req.body.liste}.`
  }, config.emailOptions);

  mailer.sendMail(mailOptions, (err) => {
    if (err) return next(err);

    res.redirect('/etape-2/confirmation');
  });
}));

router.get('/confirmation/:token', wrap(async (req, res) => {
  var email = await redis.getAsync(`requests:confirmations:${req.params.token}`);
  if (!email) {
    return res.status(401).render('errorMessage', {
      message: 'Ce lien est invalide ou périmé. Cela signifie probablement que vous\
      avez demandé et reçu un autre lien plus récemment. Merci de vérifier dans\
      votre boîte mail.'
    });
  }

  var flags = await redis.getAsync(`requests:${email}:posted`);
  await redis.setAsync(`requests:${email}:posted`, flags | consts.requestHasConfirm);

  return res.redirect('/confirmation');
}));


router.get('/annulation/:token', wrap(async (req, res) => {
  try{
    await checkRequestCancelToken(req.params.token);
    return res.render('annulation');
  } catch (err) {
    return res.status(401).render('errorMessage', {
      message: 'Ce lien est invalide ou périmé. Cela signifie probablement que vous\
      avez demandé et reçu un autre lien plus récemment. Merci de vérifier dans\
      votre boîte mail.'
    });
  }


}));

router.post('/annulation/:token', wrap(async (req, res) => {
  if (!('type' in req.body)) {
    return res.statusCode(400).end();
  }

  let requestEmail, offerEmail;

  try {
    [requestEmail, offerEmail] = await checkRequestCancelToken(req.params.token);
  } catch(err) {
    return res.status(401).render('errorMessage', {
      message: 'Ce lien est invalide ou périmé. Cela signifie probablement que vous\
      avez demandé et reçu un autre lien plus récemment. Merci de vérifier dans\
      votre boîte mail.'
    });
  }

  await cancelMatch(requestEmail, offerEmail);

  // supprimer le mandant si l'utilisateur l'a demandé
  if(req.body.type === 'delete') {
    await redis.delAsync(`requests:${requestEmail}:insee`);
  }

  return res.render('annulationConfirmation.pug', {deleted: req.body.type === 'delete'});

}));

module.exports = router;
