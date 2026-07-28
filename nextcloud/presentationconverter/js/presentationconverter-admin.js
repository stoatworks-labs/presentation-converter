/* global OC, t */
;(function () {
  'use strict'

  const form = document.getElementById('pconv-admin-form')
  if (!form) return

  const message = document.getElementById('pconv-admin-message')
  const testButton = document.getElementById('pconv-test')

  const url = (suffix) => OC.generateUrl('/apps/presentationconverter' + suffix)

  function request(suffix, body) {
    return fetch(url(suffix), {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        requesttoken: OC.requestToken
      },
      body: JSON.stringify(body || {})
    }).then(async (response) => {
      const parsed = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(parsed.error || 'Request failed')
      return parsed
    })
  }

  function describe(report) {
    const lines = []
    if (report.local.configured) {
      lines.push((report.local.ok ? '✓ ' : '✗ ') + 'Local: ' + report.local.detail)
    }
    if (report.worker.configured) {
      lines.push((report.worker.ok ? '✓ ' : '✗ ') + 'Worker: ' + report.worker.detail)
    }
    return lines.length > 0 ? lines.join(' · ') : t('presentationconverter', 'Nothing configured yet.')
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    message.textContent = t('presentationconverter', 'Saving…')

    request('/admin/settings', {
      cliPath: document.getElementById('pconv-cli').value,
      workerUrl: document.getElementById('pconv-worker').value,
      workerToken: document.getElementById('pconv-token').value,
      outputSubfolder: document.getElementById('pconv-subfolder').value,
      enabled: document.getElementById('pconv-enabled').checked ? 'yes' : 'no',
      timeout: Number(document.getElementById('pconv-timeout').value) || 300
    })
      .then((body) => {
        // Clear the token field so a saved secret is never left on screen.
        document.getElementById('pconv-token').value = ''
        message.textContent = t('presentationconverter', 'Saved. ') + describe(body.test)
      })
      .catch((error) => {
        message.textContent = error.message
      })
  })

  testButton.addEventListener('click', () => {
    message.textContent = t('presentationconverter', 'Testing…')
    request('/admin/test')
      .then((report) => {
        message.textContent = describe(report)
      })
      .catch((error) => {
        message.textContent = error.message
      })
  })
})()
