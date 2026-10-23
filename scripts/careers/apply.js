// Demo apply form for the careers site (scripts/careers/build.ts). It validates in this tab, then
// shows a confirmation and clears the form. It never sends or stores anything: no network calls, no
// storage, and the form itself has no action (method="dialog" outside a dialog submits nowhere).
(function () {
  'use strict'
  var form = document.getElementById('apply-form')
  var done = document.getElementById('apply-done')
  if (!form || !done) return
  var summary = document.getElementById('apply-errors')
  var summaryTitle = document.getElementById('apply-errors-h')
  var summaryList = summary.querySelector('.errors__list')
  var thanks = document.getElementById('apply-done-thanks')
  var again = document.getElementById('apply-again')
  var submitted = false

  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
  var WEB = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i
  var RESUME = /\.(pdf|docx?|txt|rtf|odt)$/i
  var MAX_BYTES = 10 * 1024 * 1024

  function value(id) {
    var el = document.getElementById(id)
    return el ? String(el.value || '').trim() : ''
  }

  // Each check returns an error message or ''.
  var checks = {
    'f-name': function () {
      return value('f-name').length < 2 ? 'Enter your full name.' : ''
    },
    'f-email': function () {
      var v = value('f-email')
      if (!v) return 'Enter your email address.'
      return EMAIL.test(v) ? '' : 'Enter an email address in the format name@example.com.'
    },
    'f-phone': function () {
      var v = value('f-phone')
      if (!v) return ''
      var digits = v.replace(/\D/g, '').length
      return /^[+\d\s().\-]+$/.test(v) && digits >= 7 && digits <= 15 ? '' : 'Enter a phone number with at least 7 digits, or leave it blank.'
    },
    'f-link': function () {
      var v = value('f-link')
      if (!v) return ''
      return WEB.test(v) ? '' : 'Enter a web address, like linkedin.com/in/yourname, or leave it blank.'
    },
    'f-resume': function () {
      var el = document.getElementById('f-resume')
      var file = el && el.files && el.files[0]
      if (!file) return ''
      if (!RESUME.test(file.name)) return 'Choose a PDF, Word or text file, or leave it empty.'
      return file.size > MAX_BYTES ? 'Choose a file smaller than 10 MB.' : ''
    },
    'f-answer': function () {
      var v = value('f-answer')
      if (!v) return 'Answer the question about this role.'
      return v.length < 20 ? 'Write at least a sentence (20 characters or more).' : ''
    },
  }
  var order = ['f-name', 'f-email', 'f-phone', 'f-link', 'f-resume', 'f-answer']

  function show(id, message) {
    var el = document.getElementById(id)
    var err = document.getElementById(id + '-error')
    if (!el || !err) return
    if (message) {
      el.setAttribute('aria-invalid', 'true')
      err.textContent = message
      err.hidden = false
    } else {
      el.removeAttribute('aria-invalid')
      err.textContent = ''
      err.hidden = true
    }
  }

  function validate() {
    var errors = []
    for (var i = 0; i < order.length; i++) {
      var id = order[i]
      var message = checks[id]()
      show(id, message)
      if (message) errors.push({ id: id, message: message })
    }
    return errors
  }

  function renderSummary(errors) {
    summaryList.textContent = ''
    if (!errors.length) {
      summary.hidden = true
      return
    }
    summaryTitle.textContent = errors.length === 1 ? 'There is 1 problem with the form' : 'There are ' + errors.length + ' problems with the form'
    for (var i = 0; i < errors.length; i++) {
      var li = document.createElement('li')
      var a = document.createElement('a')
      a.href = '#' + errors[i].id
      a.textContent = errors[i].message
      a.setAttribute('data-field', errors[i].id)
      li.appendChild(a)
      summaryList.appendChild(li)
    }
    summary.hidden = false
  }

  summaryList.addEventListener('click', function (ev) {
    var a = ev.target.closest ? ev.target.closest('a[data-field]') : null
    if (!a) return
    var field = document.getElementById(a.getAttribute('data-field'))
    if (!field) return
    ev.preventDefault()
    field.focus()
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    var label = form.querySelector('label[for="' + field.id + '"]')
    ;(label || field).scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
  })

  // After the first submit, fields re-check as they change so fixed errors clear right away.
  function recheck(ev) {
    var id = ev.target && ev.target.id
    if (!submitted || !checks[id]) return
    show(id, checks[id]())
    var errors = []
    for (var i = 0; i < order.length; i++) {
      var err = document.getElementById(order[i] + '-error')
      if (err && !err.hidden) errors.push({ id: order[i], message: err.textContent })
    }
    renderSummary(errors)
  }
  form.addEventListener('change', recheck)
  form.addEventListener('focusout', recheck)

  form.addEventListener('submit', function (ev) {
    ev.preventDefault()
    submitted = true
    var errors = validate()
    renderSummary(errors)
    if (errors.length) {
      summary.focus()
      return
    }
    var first = value('f-name').split(/\s+/)[0]
    form.reset()
    submitted = false
    renderSummary([])
    thanks.textContent = first ? 'Thanks, ' + first + ', for trying the demo.' : 'Thanks for trying the demo.'
    form.hidden = true
    done.hidden = false
    var title = document.getElementById('apply-done-h')
    if (title) title.focus()
  })

  if (again) {
    again.addEventListener('click', function () {
      done.hidden = true
      form.hidden = false
      var name = document.getElementById('f-name')
      if (name) name.focus()
    })
  }
})()
