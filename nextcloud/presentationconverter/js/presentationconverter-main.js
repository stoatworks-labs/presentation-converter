/* global OC, OCP, t */
;(function () {
  'use strict'

  const root = document.getElementById('presentationconverter')
  if (!root) return

  const tbody = document.getElementById('pconv-folders')
  const form = document.getElementById('pconv-add-form')
  const pathInput = document.getElementById('pconv-path')
  const message = document.getElementById('pconv-message')

  const url = (suffix) => OC.generateUrl('/apps/presentationconverter' + suffix)

  function request(suffix, options) {
    return fetch(url(suffix), {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        requesttoken: OC.requestToken
      },
      ...options
    }).then(async (response) => {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Request failed')
      return body
    })
  }

  function notify(text, isError) {
    message.textContent = text
    message.hidden = !text
    message.className = 'pconv-banner' + (isError ? ' pconv-banner--error' : ' pconv-banner--ok')
  }

  function formatWhen(seconds) {
    if (!seconds) return t('presentationconverter', 'Never')
    return OC.Util.relativeModifiedDate
      ? OC.Util.relativeModifiedDate(seconds * 1000)
      : new Date(seconds * 1000).toLocaleString()
  }

  function formatResult(result) {
    if (!result) return '—'
    const parts = [t('presentationconverter', '{n} converted', { n: result.converted })]
    if (result.skipped) parts.push(t('presentationconverter', '{n} up to date', { n: result.skipped }))
    if (result.failed) parts.push(t('presentationconverter', '{n} failed', { n: result.failed }))
    return parts.join(', ')
  }

  function render(folders) {
    tbody.innerHTML = ''

    if (folders.length === 0) {
      const row = tbody.insertRow()
      row.className = 'pconv-empty'
      const cell = row.insertCell()
      cell.colSpan = 4
      cell.textContent = t('presentationconverter', 'No folders yet. Add one above.')
      return
    }

    folders.forEach((folder) => {
      const row = tbody.insertRow()

      const pathCell = row.insertCell()
      pathCell.className = 'pconv-path'
      pathCell.textContent = folder.path

      row.insertCell().textContent = formatWhen(folder.lastScan)

      const resultCell = row.insertCell()
      resultCell.textContent = formatResult(folder.lastResult)
      if (folder.lastResult && folder.lastResult.failed) resultCell.classList.add('pconv-bad')

      const actions = row.insertCell()
      actions.className = 'pconv-actions'

      const scan = document.createElement('button')
      scan.textContent = t('presentationconverter', 'Convert now')
      scan.addEventListener('click', () => {
        scan.disabled = true
        scan.textContent = t('presentationconverter', 'Converting…')
        request('/folders/' + folder.id + '/scan', { method: 'POST' })
          .then((body) => {
            notify(
              t('presentationconverter', 'Finished: ') + formatResult(body.summary),
              body.summary.failed > 0
            )
            load()
          })
          .catch((error) => {
            notify(error.message, true)
            scan.disabled = false
            scan.textContent = t('presentationconverter', 'Convert now')
          })
      })
      actions.appendChild(scan)

      const remove = document.createElement('button')
      remove.textContent = t('presentationconverter', 'Remove')
      remove.className = 'pconv-danger'
      remove.addEventListener('click', () => {
        // Only stops future conversions; already-generated PDFs are left alone.
        request('/folders/' + folder.id, { method: 'DELETE' })
          .then(load)
          .catch((error) => notify(error.message, true))
      })
      actions.appendChild(remove)
    })
  }

  function load() {
    request('/folders', { method: 'GET' })
      .then((body) => render(body.folders || []))
      .catch((error) => notify(error.message, true))
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const path = pathInput.value.trim()
    if (!path) return

    request('/folders', { method: 'POST', body: JSON.stringify({ path }) })
      .then(() => {
        pathInput.value = ''
        notify(t('presentationconverter', 'Folder added. It will be converted on the next scheduled run.'), false)
        load()
      })
      .catch((error) => notify(error.message, true))
  })

  load()
})()
