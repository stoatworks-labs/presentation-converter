<?php
/** @var array $_ */
declare(strict_types=1);
?>
<div id="presentationconverter-admin" class="section pconv-admin">
    <h2><?php p($l->t('Presentation Converter')); ?></h2>
    <p class="settings-hint">
        <?php p($l->t('Converts presentations to PDF and writes a .notes.json sidecar with the presenter notes.')); ?>
    </p>

    <div class="pconv-status">
        <div class="pconv-status-row <?php p($_['status']['local']['ok'] ? 'ok' : ($_['status']['local']['configured'] ? 'bad' : 'off')); ?>">
            <strong><?php p($l->t('Local converter (LibreOffice)')); ?></strong>
            <span><?php p($_['status']['local']['configured'] ? $_['status']['local']['detail'] : $l->t('Not configured')); ?></span>
        </div>
        <div class="pconv-status-row <?php p($_['status']['worker']['ok'] ? 'ok' : ($_['status']['worker']['configured'] ? 'bad' : 'off')); ?>">
            <strong><?php p($l->t('macOS worker (Keynote)')); ?></strong>
            <span><?php p($_['status']['worker']['configured'] ? $_['status']['worker']['detail'] : $l->t('Not configured')); ?></span>
        </div>
    </div>

    <form id="pconv-admin-form">
        <p>
            <label for="pconv-enabled">
                <input type="checkbox" id="pconv-enabled" <?php if ($_['enabled'] === 'yes') { p('checked'); } ?> />
                <?php p($l->t('Run scheduled conversions')); ?>
            </label>
        </p>

        <p>
            <label for="pconv-cli"><?php p($l->t('Path to the presentation-converter CLI')); ?></label><br />
            <input type="text" id="pconv-cli" value="<?php p($_['cliPath']); ?>"
                   placeholder="/var/www/presentation-converter/bin/presentation-converter" size="60" />
            <em class="settings-hint">
                <?php p($l->t('Must be executable by the web server user. Requires LibreOffice on this server for PowerPoint and ODP files.')); ?>
            </em>
        </p>

        <p>
            <label for="pconv-worker"><?php p($l->t('macOS worker URL (optional)')); ?></label><br />
            <input type="text" id="pconv-worker" value="<?php p($_['workerUrl']); ?>"
                   placeholder="http://mac-mini.local:4747" size="60" />
            <em class="settings-hint">
                <?php p($l->t('A Mac running "presentation-converter serve". Required for Keynote (.key) files, which cannot be converted on Linux.')); ?>
            </em>
        </p>

        <p>
            <label for="pconv-token"><?php p($l->t('Worker token')); ?></label><br />
            <input type="password" id="pconv-token" autocomplete="new-password" size="40"
                   placeholder="<?php p($_['workerTokenSet'] ? $l->t('(unchanged)') : $l->t('none set')); ?>" />
            <em class="settings-hint"><?php p($l->t('Leave blank to keep the current token.')); ?></em>
        </p>

        <p>
            <label for="pconv-subfolder"><?php p($l->t('Write output into a subfolder (optional)')); ?></label><br />
            <input type="text" id="pconv-subfolder" value="<?php p($_['outputSubfolder']); ?>" placeholder="PDF" size="30" />
            <em class="settings-hint"><?php p($l->t('Leave blank to write each PDF beside its presentation.')); ?></em>
        </p>

        <p>
            <label for="pconv-timeout"><?php p($l->t('Per-file timeout (seconds)')); ?></label><br />
            <input type="number" id="pconv-timeout" value="<?php p((string)$_['timeout']); ?>" min="30" max="3600" />
        </p>

        <p>
            <button type="submit" class="primary"><?php p($l->t('Save')); ?></button>
            <button type="button" id="pconv-test"><?php p($l->t('Test connection')); ?></button>
            <span id="pconv-admin-message" class="pconv-muted"></span>
        </p>
    </form>
</div>
