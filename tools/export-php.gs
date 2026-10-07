/**
 * Salin file ini ke project Apps Script yang sama dengan Code.gs, lalu jalankan
 * exportProductionForPhp(). File JSON memuat data pribadi/foto: simpan privat.
 * Tidak menghapus data. Helper lama dapat menyelaraskan skema/arsip seperti pada
 * pembacaan aplikasi biasa. Password dan sesi lama tidak diekspor.
 */
function exportProductionForPhp() {
  return withWriteLock_(function () {
    const apdEntries = getApdEntries_();
    const photos = [];
    const ids = {};
    apdEntries.forEach(function (entry) {
      (entry.photoFileIds || []).forEach(function (id) {
        if (ids[id]) return;
        ids[id] = true;
        const file = apdPhotoFile_(id);
        const blob = file.getBlob();
        const description = String(file.getDescription() || "");
        photos.push({
          id: id,
          owner: description.replace(/^APD bukti; uploadedBy=/, "") || entry.createdBy,
          dataUrl: "data:" + blob.getContentType() + ";base64," + Utilities.base64Encode(blob.getBytes())
        });
      });
    });
    const auditSheet = deletedEntryAuditSheet_();
    const auditRows = auditSheet.getLastRow() > 1
      ? auditSheet.getRange(2, 1, auditSheet.getLastRow() - 1, APP.DELETED_ENTRY_AUDIT_HEADERS.length).getValues()
      : [];
    const snapshot = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      master: getMaster_(),
      settings: getSettings_(),
      users: getUsers_(),
      entries: getEntries_(),
      spkEntries: getSpkEntries_(),
      apdEntries: apdEntries,
      adjustments: getPressAdjustments_(),
      downtimeEntries: getDowntimeEntries_(),
      audits: auditRows.map(function (r) {
        return { id: Utilities.getUuid(), tab: String(r[0]), tanggal: formatDateCell_(r[1]), operator: String(r[2]), produk: String(r[3]), botol: String(r[4]), batchNo: String(r[5]), nextUpdateCount: number_(r[6]), deletedAt: isoCell_(r[7]), deletedBy: String(r[8]), restoredEntryId: String(r[9]), restoredAt: isoCell_(r[10]) };
      }),
      photos: photos
    };
    const file = DriveApp.createFile('laporan-produksi-php-' + Date.now() + '.json', JSON.stringify(snapshot), MimeType.PLAIN_TEXT);
    console.log(file.getUrl());
    return file.getUrl();
  });
}
